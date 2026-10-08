// DWG の読み取りの評価関数（開発用）: 読んだ値を、AutoCAD 自身が書き出した値と突き合わせる。
//
//   node program/tools/dwg-check.mjs フォルダか .dwg … [--verbose]
//
// .dwg の隣に同じ名前の .txt（AutoCAD の VLA の値の一覧。LibreDWG の試験データ test/test-data/<版>/*.txt の形）があれば、
// その図形を ハンドルで探し、値（中心・半径・始点・文字列・画層など）を 1 つずつ比べる（数は 6 桁の表示なので、相対 1e-5 まで同じとみる）。
// .txt が無いものは、読めたオブジェクトの数と、読めなかったオブジェクトの数だけを数える。
// 出力: ファイルごとの 読めた／読めない オブジェクト・比べた値の数・合わなかった値。最後に全体の合計。

import fs from "node:fs";
import path from "node:path";
import { readDwgObjects, VERSION_NAME } from "../app/static/js/formats/dwg/index.js";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const files = args.filter((a) => !a.startsWith("--")).flatMap((a) =>
  fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter((f) => /\.dwg$/i.test(f)).map((f) => path.join(a, f)) : [a]);

/** AutoCAD の VLA の値の一覧（.txt）を、図形ごとの { 名前: 値 } にする */
function readVla(text) {
  const entities = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#<VLA-OBJECT")) entities.push((current = {}));
    const m = line.match(/^;\s+(\w+)(?: \(RO\))? = (.*)$/);
    if (m && current) current[m[1]] = parseValue(m[2]);
  }
  return entities;
}

function parseValue(text) {
  if (/^".*"$/.test(text)) return text.slice(1, -1);
  if (text.startsWith("(")) {
    const items = text.slice(1, -1).trim().split(/\s+/);
    const numbers = items.filter((s) => s !== "...").map(Number);
    return { list: numbers, truncated: items.includes("...") };
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}

const close = (a, b) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b)) + 1e-9;

/** 読んだ値（数・点・数の並び）と AutoCAD の値を比べる。並びは、AutoCAD が省いた（...）ところまで */
function same(ours, theirs) {
  if (theirs && typeof theirs === "object" && "list" in theirs) {
    const flat = Array.isArray(ours) ? ours.flat(2) : [];
    if (!theirs.truncated && flat.length !== theirs.list.length) return false;
    return theirs.list.every((v, i) => flat[i] !== undefined && close(flat[i], v));
  }
  if (typeof theirs === "number") return typeof ours === "number" && close(ours, theirs);
  return String(ours) === String(theirs);
}

const deg = (v) => v; // VLA の角度はラジアン
const angleOf = (d) => Math.atan2(d[1], d[0]);
const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// AutoCAD の図形の名前 → 比べる値（VLA の名前 → 読んだ値を取り出す関数）
const COMMON = {
  Layer: (o, x) => x.layerName(o.layer),
  LinetypeScale: (o) => o.ltscale,
  Lineweight: (o) => o.lineweight,
  Visible: (o) => (o.invisible ? 0 : -1),
  Linetype: (o, x) => ["ByLayer", "ByBlock", "Continuous"][o.ltypeFlags] ?? x.name(o.ltype),
};
const PROPS = {
  AcDbLine: { StartPoint: (o) => o.a, EndPoint: (o) => o.b, Thickness: (o) => o.thickness },
  AcDbArc: { Center: (o) => o.center, Radius: (o) => o.radius, StartAngle: (o) => norm(o.start), EndAngle: (o) => norm(o.end), Thickness: (o) => o.thickness },
  AcDbCircle: { Center: (o) => o.center, Radius: (o) => o.radius, Thickness: (o) => o.thickness },
  AcDbEllipse: { Center: (o) => o.center, MajorAxis: (o) => o.major, RadiusRatio: (o) => o.ratio, StartParameter: (o) => o.start, EndParameter: (o) => o.end },
  AcDbPolyline: { Coordinates: (o) => o.points, Closed: (o) => (o.closed ? -1 : 0), ConstantWidth: (o) => o.constWidth, Elevation: (o) => o.elevation, Thickness: (o) => o.thickness },
  AcDb3dPolyline: { Coordinates: (o, x) => x.children(o).map((v) => v.p), Closed: (o) => (o.flags & 1 ? -1 : 0) },
  AcDbMText: { InsertionPoint: (o) => o.p, Height: (o) => o.height, Width: (o) => o.width, TextString: (o) => o.text, AttachmentPoint: (o) => o.attach,
    DrawingDirection: (o) => o.drawing, Rotation: (o) => norm(angleOf(o.direction)), LineSpacingFactor: (o) => o.lineSpacing, StyleName: (o, x) => x.name(o.style) },
  AcDbText: { TextString: (o) => o.text, Height: (o) => o.height, Rotation: (o) => o.rotation, ScaleFactor: (o) => o.widthFactor, ObliqueAngle: (o) => o.oblique,
    InsertionPoint: (o) => o.p, StyleName: (o, x) => x.name(o.style) },
  AcDbAttributeDefinition: { TagString: (o) => o.tag, PromptString: (o) => o.prompt, TextString: (o) => o.text, Height: (o) => o.height, InsertionPoint: (o) => o.p },
  AcDbPoint: { Coordinates: (o) => o.p, Thickness: (o) => o.thickness },
  AcDbRay: { BasePoint: (o) => o.p, DirectionVector: (o) => o.direction },
  AcDbXline: { BasePoint: (o) => o.p, DirectionVector: (o) => o.direction },
  AcDbSpline: { Degree: (o) => o.degree, ControlPoints: (o) => o.controls, Knots: (o) => o.knots, FitPoints: (o) => o.fit,
    NumberOfControlPoints: (o) => o.controls.length, NumberOfFitPoints: (o) => o.fit.length, IsRational: (o) => (o.rational ? -1 : 0), IsPeriodic: (o) => (o.periodic ? -1 : 0) },
  AcDbBlockReference: { InsertionPoint: (o) => o.p, XScaleFactor: (o) => o.scale[0], YScaleFactor: (o) => o.scale[1], ZScaleFactor: (o) => o.scale[2],
    Rotation: (o) => o.rotation, Name: (o, x) => x.name(o.block) },
  AcDbHatch: { PatternName: (o) => o.pattern, NumberOfLoops: (o) => o.loops.length, PatternAngle: (o) => o.angle ?? 0, PatternScale: (o) => o.scale ?? 1, Elevation: (o) => o.elevation },
  AcDbLeader: { Coordinates: (o) => o.points },
  AcDbTrace: { Coordinates: (o) => o.points, Thickness: (o) => o.thickness },
  AcDbFace: { Coordinates: (o) => o.points },
  AcDbAlignedDimension: { Measurement: (o) => o.measurement, TextPosition: (o) => o.textMid, ExtLine1Point: (o) => o.p13, ExtLine2Point: (o) => o.p14 },
  AcDbRotatedDimension: { Measurement: (o) => o.measurement, TextPosition: (o) => o.textMid, Rotation: (o) => o.dimRotation },
  AcDbRadialDimension: { Measurement: (o) => o.measurement, TextPosition: (o) => o.textMid, Center: (o) => o.p10, ChordPoint: (o) => o.p15 },
  AcDbDiametricDimension: { Measurement: (o) => o.measurement, TextPosition: (o) => o.textMid },
  AcDbOrdinateDimension: { Measurement: (o) => o.measurement, TextPosition: (o) => o.textMid },
  AcDb3PointAngularDimension: { Measurement: (o) => o.measurement, TextPosition: (o) => o.textMid, AngleVertex: (o) => o.p15 },
  AcDb2LineAngularDimension: { Measurement: (o) => o.measurement, TextPosition: (o) => o.textMid },
};

let total = { files: 0, objects: 0, failed: 0, checked: 0, wrong: 0, missing: 0 };
for (const file of files) {
  let res;
  try {
    res = readDwgObjects(new Uint8Array(fs.readFileSync(file)));
  } catch (error) {
    console.log(`${path.relative(process.cwd(), file)}  読めない: ${error.message}`);
    total.files++;
    total.failed++;
    continue;
  }
  const { objects } = res;
  const x = {
    name: (h) => objects.get(h)?.name ?? `#${h?.toString(16)}`,
    layerName: (h) => objects.get(h)?.name ?? `#${h?.toString(16)}`,
    children: (o) => [...objects.values()].filter((c) => c.owner === o.handle && /^VERTEX/.test(c.kind)).sort((a, b) => a.handle - b.handle),
  };
  let checked = 0, wrong = 0, missing = 0;
  const notes = [];
  const txt = file.replace(/\.dwg$/i, ".txt");
  if (fs.existsSync(txt)) {
    for (const vla of readVla(fs.readFileSync(txt, "latin1"))) {
      const handle = parseInt(vla.Handle, 16);
      const object = objects.get(handle);
      const props = PROPS[vla.ObjectName];
      if (!object) {
        missing++;
        notes.push(`  ${vla.ObjectName} #${vla.Handle}: 読めていない`);
        continue;
      }
      if (!props) {
        notes.push(`  ${vla.ObjectName} #${vla.Handle}: 比べ方が未定義（${object.kind}）`);
        continue;
      }
      for (const [name, get] of Object.entries({ ...COMMON, ...props })) {
        if (!(name in vla)) continue;
        let ours;
        try {
          ours = get(object, x);
        } catch (error) {
          ours = `（${error.message}）`;
        }
        checked++;
        if (!same(ours, vla[name])) {
          wrong++;
          notes.push(`  ${vla.ObjectName} #${vla.Handle} ${name}: 読んだ ${JSON.stringify(ours)} / AutoCAD ${JSON.stringify(vla[name])}`);
        }
      }
    }
  }
  const failed = res.failures.length;
  const line = `${path.relative(process.cwd(), file)}  ${VERSION_NAME[res.version]}  オブジェクト ${objects.size}` +
    (failed ? `  読めない ${failed}（${[...new Set(res.failures.map((f) => f.kind))].join("・")}）` : "") +
    (checked ? `  値 ${checked - wrong}/${checked}` : "") + (missing ? `  図形なし ${missing}` : "");
  console.log(line);
  if (verbose || wrong || missing) for (const n of notes) console.log(n);
  if (verbose) for (const f of res.failures) console.log(`  読めない ${f.kind} #${f.handle.toString(16)}: ${f.message}`);
  total = { files: total.files + 1, objects: total.objects + objects.size, failed: total.failed + failed, checked: total.checked + checked, wrong: total.wrong + wrong, missing: total.missing + missing };
}
console.log(`\n合計: ファイル ${total.files}・オブジェクト ${total.objects}（読めない ${total.failed}）・値 ${total.checked - total.wrong}/${total.checked}（合わない ${total.wrong}）・図形なし ${total.missing}`);
void deg;
