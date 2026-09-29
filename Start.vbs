' ============================================================
'  Inventor 3Dツール  起動ファイル（ダブルクリックで開く・ファイルをドロップして開く）
'  - 配る形: このファイル（入口）と program フォルダを並べる。アプリの中身はすべて program の中
'  - Python（pythonw.exe）をコマンドを使わずに探し（黒い窓を出さない）、program\start_app.py を窓なしで起動する
'    （WScript.Shell.Exec は必ず黒い窓を開くので使わない）
'  - ドロップされたファイルは、そのまま start_app.py へ渡す。起動画面・サーバー・受け渡しは program\launch_guard.py が受け持つ
'      .json（変換データ） Inventor で部品を作る
'      それ以外           アプリで開く（.iam は、同じフォルダの .ipt も部品として一緒に）
'  - このファイルは Shift-JIS（CP932）・CRLF で保存する（WSH がそのまま読める形）
' ============================================================
Option Explicit
Dim fso, sh, base, app, pyw, cmd, logDir, logFile, i

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
app  = base & "\program"       ' アプリの中身の置き場（入口はこの Start.vbs だけ）

logDir  = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Inventor3DTool\logs"
CreateFolderTree logDir
logFile = logDir & "\vbs_launcher.log"
LogLine "START base=" & base & " args=" & WScript.Arguments.Count

If Not fso.FileExists(app & "\start_app.py") Then
  LogLine "ERROR program folder not found"
  MsgBox "アプリの中身（program フォルダ）が見つかりません。" & vbCrLf & vbCrLf & _
         "この Start.vbs と同じ場所に program フォルダを置いてください（2 つ並べて使います）。" & vbCrLf & _
         "探した場所: " & app, vbExclamation, "Inventor 3Dツール - 起動できません"
  WScript.Quit 1
End If

pyw = ResolvePythonW()
If pyw = "" Then
  LogLine "ERROR pythonw not found"
  MsgBox "Python（pythonw.exe）が見つかりません。" & vbCrLf & vbCrLf & _
         "python.org から Windows 版の Python（3.10 以上）を入れてから、もう一度開いてください。" & vbCrLf & _
         "詳しい状況は、program フォルダの start.bat（診断起動）で確かめられます。", _
         vbExclamation, "Inventor 3Dツール - 起動できません"
  WScript.Quit 1
End If

' サーバー・起動画面は start_app.py が開く（0 = 窓を出さない）。ドロップされたファイルはそのまま渡す
cmd = """" & pyw & """ """ & app & "\start_app.py"""
For i = 0 To WScript.Arguments.Count - 1 ' For Each ではなく番号で回す（どの実装でも動く）
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
LogLine "SPAWN " & cmd
sh.Run cmd, 0, False

' ---------------------------------------------------------------
' pythonw.exe を探す（コマンドを使わない＝窓を出さない）
'   1) PATH の各フォルダ（Microsoft Store の仮の入口 WindowsApps は後回し）
'   2) 標準の入れ場所: %LOCALAPPDATA%\Programs\Python\Python3xx・%ProgramFiles%\Python3xx（新しい版から）
'   3) py ランチャーの pyw.exe（C:\Windows\pyw.exe）
'   4) WindowsApps の pythonw.exe（Store 版が入っているとき）
' ---------------------------------------------------------------
Function ResolvePythonW()
  Dim parts, j, dir, cand, storeCand, roots, r
  ResolvePythonW = ""
  storeCand = ""
  parts = Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
  For j = 0 To UBound(parts)
    dir = Trim(parts(j))
    If dir <> "" Then
      cand = fso.BuildPath(dir, "pythonw.exe")
      If fso.FileExists(cand) Then
        If InStr(1, LCase(cand), "\windowsapps\", vbTextCompare) > 0 Then
          If storeCand = "" Then storeCand = cand
        Else
          ResolvePythonW = cand : Exit Function
        End If
      End If
    End If
  Next
  roots = Array(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python", _
                sh.ExpandEnvironmentStrings("%ProgramFiles%"), "C:\")
  For Each r In roots
    cand = NewestPython(r)
    If cand <> "" Then ResolvePythonW = cand : Exit Function
  Next
  cand = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\pyw.exe"
  If fso.FileExists(cand) Then ResolvePythonW = cand : Exit Function
  ResolvePythonW = storeCand
End Function

' root の直下の Python3xx フォルダのうち、いちばん新しい版の pythonw.exe
Function NewestPython(root)
  Dim folder, fld, best, bestNum, num, cand
  NewestPython = "" : bestNum = -1
  If Not fso.FolderExists(root) Then Exit Function
  On Error Resume Next
  Set folder = fso.GetFolder(root)
  For Each fld In folder.SubFolders
    If LCase(Left(fld.Name, 7)) = "python3" Then
      num = VersionNumber(Mid(fld.Name, 7))
      cand = fld.Path & "\pythonw.exe"
      If num > bestNum And fso.FileExists(cand) Then bestNum = num : best = cand
    End If
  Next
  On Error GoTo 0
  If bestNum >= 0 Then NewestPython = best
End Function

' "312" → 312、"312-32" → 312（数字の続くところまで）
Function VersionNumber(s)
  Dim k, c, digits
  digits = ""
  For k = 1 To Len(s)
    c = Mid(s, k, 1)
    If c >= "0" And c <= "9" Then digits = digits & c Else Exit For
  Next
  If digits = "" Then VersionNumber = 0 Else VersionNumber = CLng(digits)
End Function

Sub CreateFolderTree(p)
  If fso.FolderExists(p) Then Exit Sub
  CreateFolderTree fso.GetParentFolderName(p)
  If Not fso.FolderExists(p) Then fso.CreateFolder p
End Sub

Sub LogLine(msg)
  On Error Resume Next
  Dim f : Set f = fso.OpenTextFile(logFile, 8, True)
  f.WriteLine Now() & " " & msg
  f.Close
End Sub
