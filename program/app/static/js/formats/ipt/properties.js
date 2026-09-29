// OLE のプロパティセット（MS-OLEPS）を読む。Inventor の iProperties のうち、表示に使うものだけを取り出す。
//   Design Tracking Properties（ストリーム名 \x05PypkizqiUjudbposAayal4qdGf）
//     PID 20 … 材質の名前（例: 鋼、軟鋼）
//     PID 61 … 密度（g/cm³。同じ部品を書き出した STEP の密度と単位つきで一致することを tests/js/assembly.test.mjs で確かめている）

const DESIGN_TRACKING = "\u0005PypkizqiUjudbposAayal4qdGf";
const PID_MATERIAL = 20;
const PID_DENSITY = 61;
const VT = { I2: 2, I4: 3, R4: 4, R8: 5, BOOL: 11, LPSTR: 0x1e, LPWSTR: 0x1f };

/** プロパティセットのストリーム → Map<PID, 値>（数値・文字列だけ） */
export function readPropertySet(bytes) {
  const out = new Map();
  if (!bytes || bytes.length < 48) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = view.getUint32(24, true);
  for (let s = 0; s < sections; s++) {
    const base = view.getUint32(28 + s * 20 + 16, true);
    if (base + 8 > bytes.length) break;
    const count = view.getUint32(base + 4, true);
    let codepage = 1252;
    const entries = [];
    for (let i = 0; i < count && base + 8 + i * 8 + 8 <= bytes.length; i++) {
      entries.push([view.getUint32(base + 8 + i * 8, true), base + view.getUint32(base + 12 + i * 8, true)]);
    }
    for (const [pid, at] of entries) if (pid === 1 && at + 6 <= bytes.length) codepage = view.getUint16(at + 4, true); // PID 1 = 文字コード
    for (const [pid, at] of entries) {
      if (at + 8 > bytes.length) continue;
      const type = view.getUint16(at, true), v = at + 4;
      if (type === VT.I2) out.set(pid, view.getInt16(v, true));
      else if (type === VT.I4) out.set(pid, view.getInt32(v, true));
      else if (type === VT.R4) out.set(pid, view.getFloat32(v, true));
      else if (type === VT.R8) out.set(pid, view.getFloat64(v, true));
      else if (type === VT.BOOL) out.set(pid, view.getInt16(v, true) !== 0);
      else if (type === VT.LPWSTR || (type === VT.LPSTR && codepage === 1200)) {
        const n = view.getUint32(v, true);
        out.set(pid, new TextDecoder("utf-16le").decode(bytes.subarray(v + 4, v + 4 + n * 2)).replace(/\u0000+$/, ""));
      } else if (type === VT.LPSTR) {
        const n = view.getUint32(v, true);
        out.set(pid, new TextDecoder(codepage === 932 ? "shift_jis" : codepage === 65001 ? "utf-8" : "windows-1252").decode(bytes.subarray(v + 4, v + 4 + n)).replace(/\u0000+$/, ""));
      }
    }
  }
  return out;
}

/** 材質と密度（g/cm³）。無ければ null */
export function materialOf(streams) {
  const props = readPropertySet(streams.get(DESIGN_TRACKING));
  const material = props.get(PID_MATERIAL);
  const density = props.get(PID_DENSITY);
  return { material: typeof material === "string" && material ? material : null, density_g_per_cm3: typeof density === "number" && density > 0 ? density : null };
}
