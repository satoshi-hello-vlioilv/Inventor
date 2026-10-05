//! 子のプロセス（作る係の Python）を起こし、止めるときは孫まで止める。
//!
//! Windows では py ランチャー（py.exe）が本物の python.exe を子として起こす。py.exe だけを止めると本物が残る
//! （WaveLog で 5 回のうち 5 回起きた形）。そこで子をジョブ（Job Object）に入れ、止めるときはジョブごと止める。
//! ジョブは「持ち手が閉じたら中を全て止める」にしておくので、窓が落ちても作る係は残らない。
//! Inventor（COM）は Windows が別に起こすので、ジョブには入らない（止めても Inventor は閉じない）。
//! ほかの OS（網・開発）はプロセスグループで同じことをする。

use std::ffi::OsString;
use std::path::Path;
use std::process::{Child, Command, Stdio};

/// 子の起こし方（引数の並び。先頭が実行するもの）。
pub type Argv = Vec<OsString>;

/// 起こした子と、孫まで止めるための持ち手。
pub struct Spawned {
    pub child: Child,
    tree: imp::Tree,
}

impl Spawned {
    /// 孫まで止める（もう終わっていれば何もしない）。
    pub fn kill_tree(&self) {
        self.tree.kill();
    }
    /// 孫まで止める係（`Spawned` を待っている糸とは別の糸から止めるため）。
    pub fn killer(&self) -> Killer {
        Killer(self.tree.clone())
    }
}

#[derive(Clone)]
pub struct Killer(imp::Tree);

impl Killer {
    pub fn kill(&self) {
        self.0.kill();
    }
}

/// 窓を出さずに起こす（Windows のコンソールの窓を出さない）。標準入力・出力は呼ぶ側が決める。
pub fn spawn(
    argv: &Argv,
    cwd: &Path,
    env: &[(OsString, OsString)],
    stdin: Stdio,
    stdout: Stdio,
    stderr: Stdio,
) -> std::io::Result<Spawned> {
    let (exe, args) = argv.split_first().ok_or_else(|| std::io::Error::other("起こすものが空です"))?;
    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(cwd).stdin(stdin).stdout(stdout).stderr(stderr);
    for (k, v) in env {
        cmd.env(k, v);
    }
    imp::prepare(&mut cmd);
    let child = cmd.spawn()?;
    let tree = imp::Tree::adopt(&child);
    Ok(Spawned { child, tree })
}

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use std::sync::Arc;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn prepare(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    /// ジョブの持ち手（最後の持ち手が閉じると、中のプロセスは全て止まる）。
    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    #[derive(Clone)]
    pub struct Tree(Option<Arc<Job>>, u32);

    impl Tree {
        /// 子をジョブに入れる。入れられなければ（ジョブを作れない古い環境）子だけを止める形にする。
        pub fn adopt(child: &Child) -> Tree {
            let job = unsafe {
                let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else { return Tree(None, child.id()) };
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set.is_err() || AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())).is_err() {
                    let _ = CloseHandle(job);
                    return Tree(None, child.id());
                }
                job
            };
            Tree(Some(Arc::new(Job(job))), child.id())
        }

        pub fn kill(&self) {
            match &self.0 {
                Some(job) => unsafe {
                    let _ = TerminateJobObject(job.0, 1);
                },
                None => {
                    let _ =
                        Command::new("taskkill").args(["/PID", &self.1.to_string(), "/T", "/F"]).creation_flags(CREATE_NO_WINDOW).status();
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};

    pub fn prepare(cmd: &mut Command) {
        cmd.process_group(0); // 子を新しいグループの頭にする（孫も同じグループに入る）
    }

    #[derive(Clone)]
    pub struct Tree(u32);

    impl Tree {
        pub fn adopt(child: &Child) -> Tree {
            Tree(child.id())
        }
        pub fn kill(&self) {
            let _ = Command::new("kill").args(["-9", "--", &format!("-{}", self.0)]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// 孫を起こして眠る Python（py ランチャーが本物の python を子に持つ形を写す）。孫の PID を書く。
    #[test]
    fn kill_tree_stops_the_grandchild_too() {
        let python = crate::locate::python().expect("網には Python が要る");
        let dir = std::env::temp_dir().join(format!("inv-proc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("grandchild.pid");
        let code = format!(
            "import subprocess, sys, time\np = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\nopen({:?}, 'w').write(str(p.pid))\ntime.sleep(60)",
            pidfile.display().to_string()
        );
        let mut argv: Argv = vec![python.exe.clone().into()];
        argv.extend(python.args.iter().map(OsString::from));
        argv.extend(["-c".into(), code.into()]);
        let mut s = spawn(&argv, &dir, &[], Stdio::null(), Stdio::null(), Stdio::null()).unwrap();
        // 数として読めるまで待つ（Python はファイルを作ってから書くので、その間に読むと空。Windows の CI で起きた）
        let end = Instant::now() + Duration::from_secs(20);
        let grandchild: u32 = loop {
            if let Some(pid) = std::fs::read_to_string(&pidfile).ok().and_then(|t| t.trim().parse().ok()) {
                break pid;
            }
            assert!(Instant::now() < end, "孫の PID が 20 秒たっても書かれない");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(alive(grandchild), "孫が動いている");
        s.kill_tree();
        let _ = s.child.wait();
        let end = Instant::now() + Duration::from_secs(10);
        while alive(grandchild) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(grandchild), "子を止めると孫も止まる（py ランチャーの先の本物の python が残らない）");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 動いているか（網だけで使う）
    fn alive(pid: u32) -> bool {
        if cfg!(windows) {
            let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
        } else {
            match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(s) => !s.rsplit(')').next().unwrap_or("").trim_start().starts_with('Z'),
                Err(_) => false,
            }
        }
    }
}
