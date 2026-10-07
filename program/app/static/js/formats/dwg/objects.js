// DWG のオブジェクト（仕様書 20 章 AcDb:AcDbObjects）: 図形・表（画層・ブロック・文字スタイル・線種）・レイアウトを読む。
// 1 つのオブジェクトは 3 つの流れからなる: 主の流れ（値）・ハンドルの流れ（ほかのオブジェクトへの参照）・
// R2007+ の文字列の流れ（UTF-16 の文字列）。値を順に読み、参照はハンドルの流れから、出てきた順に読む。
//   readObject(データ, 位置, 読み方) → { kind, handle, ...中身 }（知らない種類は { kind, handle, unknown: true }）
// 図形の共通の値: layer・ltype（ハンドル）、color（{ index, rgb? }。256 = 画層の色、0 = ブロックの色）、ltypeFlags（0 = 画層、1 = ブロック、
// 2 = 実線、3 = ltype のハンドル）、lineweight（1/100 mm。-1 = 画層、-2 = ブロック、-3 = 既定）、invisible、owner（ハンドル）、space

import { BitReader, DwgError, R14, R2000, R2004, R2007, R2010, R2013, R2018 } from "./bits.js";
import { stringStreamStart } from "./sections.js";

// 決まった型の番号（仕様書 20.3）。500 以上はクラスの節で決まる
const TYPES = {
  1: "TEXT", 2: "ATTRIB", 3: "ATTDEF", 4: "BLOCK", 5: "ENDBLK", 6: "SEQEND", 7: "INSERT", 8: "MINSERT",
  10: "VERTEX_2D", 11: "VERTEX_3D", 12: "VERTEX_MESH", 13: "VERTEX_PFACE", 14: "VERTEX_PFACE_FACE",
  15: "POLYLINE_2D", 16: "POLYLINE_3D", 17: "ARC", 18: "CIRCLE", 19: "LINE",
  20: "DIMENSION_ORDINATE", 21: "DIMENSION_LINEAR", 22: "DIMENSION_ALIGNED", 23: "DIMENSION_ANG3PT", 24: "DIMENSION_ANG2LN",
  25: "DIMENSION_RADIUS", 26: "DIMENSION_DIAMETER", 27: "POINT", 28: "3DFACE", 29: "POLYLINE_PFACE", 30: "POLYLINE_MESH",
  31: "SOLID", 32: "TRACE", 33: "SHAPE", 34: "VIEWPORT", 35: "ELLIPSE", 36: "SPLINE", 37: "REGION", 38: "3DSOLID", 39: "BODY",
  40: "RAY", 41: "XLINE", 42: "DICTIONARY", 43: "OLEFRAME", 44: "MTEXT", 45: "LEADER", 46: "TOLERANCE", 47: "MLINE",
  48: "BLOCK_CONTROL", 49: "BLOCK_HEADER", 50: "LAYER_CONTROL", 51: "LAYER", 52: "STYLE_CONTROL", 53: "STYLE",
  56: "LTYPE_CONTROL", 57: "LTYPE", 60: "VIEW_CONTROL", 61: "VIEW", 62: "UCS_CONTROL", 63: "UCS", 64: "VPORT_CONTROL", 65: "VPORT",
  66: "APPID_CONTROL", 67: "APPID", 68: "DIMSTYLE_CONTROL", 69: "DIMSTYLE", 70: "VP_ENT_HDR_CONTROL", 71: "VP_ENT_HDR",
  72: "GROUP", 73: "MLINESTYLE", 74: "OLE2FRAME", 76: "LONG_TRANSACTION", 77: "LWPOLYLINE", 78: "HATCH", 79: "XRECORD",
  80: "PLACEHOLDER", 81: "VBA_PROJECT", 82: "LAYOUT", 0x1f2: "ACAD_PROXY_ENTITY", 0x1f3: "ACAD_PROXY_OBJECT",
};
// 図形の種類（共通の図形の値を持つ）。クラスで決まる種類は、クラスの印（isEntity）で見分ける
const ENTITY_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47, 74, 77, 78, 0x1f2]);

/**
 * 1 つのオブジェクトを読む。
 * @param {Uint8Array} data オブジェクトの節（R2000 まではファイル全体）
 * @param {number} offset オブジェクトの位置（バイト）
 * @param {{ version: number, decode: Function, classes: Map }} ctx
 */
export function readObject(data, offset, ctx) {
  const { version, classes } = ctx;
  const r = new BitReader(data, offset * 8, ctx);
  const size = r.ms();
  const handleBits = version >= R2010 ? r.umc() : 0;
  const start = r.pos;
  const end = start + size * 8;
  if (end > data.length * 8) throw new DwgError("オブジェクトの大きさが節を越えています。");
  const type = r.ot();
  const cls = type >= 500 ? classes.get(type) : null;
  const kind = cls ? cls.dxfName : TYPES[type] ?? `TYPE_${type}`;
  const isEntity = cls ? cls.isEntity : ENTITY_TYPES.has(type);

  // ハンドルの流れの始まり（R13・R14 は、共通の値の途中で分かる）
  const o = { kind, type, version, r, hs: null };
  if (version >= R2010) setHandleStream(o, end - handleBits);
  else if (version >= R2000) setHandleStream(o, start + r.url());

  const object = { kind, handle: r.handle() };
  // 以後のハンドルの相対の参照（+1・-1・+n・-n）は、このオブジェクトのハンドルが基準
  r.base = object.handle;
  if (o.hs) o.hs.base = object.handle;
  skipExtendedData(r);
  o.object = object;
  o.start = start;
  const reader = READERS[kind];
  try {
    if (isEntity) readEntityCommon(o);
    else readObjectCommon(o);
    if (!reader) {
      object.unknown = true;
      return object;
    }
    reader(o);
  } catch (error) {
    error.kind = kind; // 読めなかった種類を知らせる
    throw error;
  }
  return object;
}

/** ハンドルの流れを置く。R2007+ はその直前のビットが「文字列の流れがある」の印 */
function setHandleStream(o, bit) {
  o.hs = o.r.at(bit);
  if (o.version >= R2007) {
    const strings = o.r.at(bit - 1);
    stringStreamStart(strings, bit - 1);
    o.r.strings = strings.empty ? null : strings;
  }
}

/** 拡張データ（EED）: 大きさ（BS）・アプリのハンドル・中身。読み飛ばす */
function skipExtendedData(r) {
  for (let n = r.bs(); n; n = r.bs()) {
    r.handle();
    r.skipBytes(n);
  }
}

/** 図形の共通の値（仕様書 20.4.1・20.4.2） */
function readEntityCommon(o) {
  const { r, version, object } = o;
  if (r.bit()) {
    const size = version >= R2010 ? r.bll() : r.url(); // 代わりの絵（プロキシの図形）
    r.skipBytes(size);
  }
  if (version <= R14) setHandleStream(o, o.start + r.url());
  const hs = o.hs;
  const mode = r.bb();
  if (mode === 0) object.owner = hs.handle(object.handle);
  else object.space = mode === 1 ? "paper" : "model";
  const reactors = r.bl();
  const noXdic = version >= R2004 ? r.bit() : 0;
  if (version >= R2013) r.bit();
  for (let i = 0; i < reactors; i++) hs.handle(object.handle);
  if (!noXdic) hs.handle();
  if (version <= R14) {
    object.layer = hs.handle();
    if (!r.bit()) {
      object.ltype = hs.handle();
      object.ltypeFlags = 3;
    } else object.ltypeFlags = 0;
  }
  const noLinks = version < R2004 ? r.bit() : 1;
  if (!noLinks) {
    hs.handle(object.handle);
    hs.handle(object.handle);
  }
  const { color, book } = r.enc();
  object.color = color;
  if (book) object.colorBook = hs.handle(); // DBCOLOR（色見本帳の色。RGB はそちらにある）
  object.ltscale = r.bd();
  if (version >= R2000) {
    object.layer = hs.handle();
    object.ltypeFlags = r.bb();
    if (object.ltypeFlags === 3) object.ltype = hs.handle();
    const plot = r.bb();
    if (version >= R2007) {
      if (r.bb() === 3) hs.handle(); // 材料
      r.byte(); // 影
    }
    if (plot === 3) hs.handle();
    if (version >= R2010) {
      for (let i = 0; i < 3; i++) if (r.bit()) hs.handle(); // 表示スタイル
    }
  }
  object.invisible = Boolean(r.bs() & 1);
  object.lineweight = version >= R2000 ? lineweight(r.byte()) : -1;
}

/** 線の太さ（RC）→ 1/100 mm。29 = 画層、30 = ブロック、31 = 既定 */
const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
function lineweight(code) {
  if (code === 29) return -1;
  if (code === 30) return -2;
  if (code === 31) return -3;
  return LINEWEIGHTS[code] ?? -3;
}

/** 図形でないオブジェクトの共通の値（仕様書 20.1）: 持ち主・反応子・拡張辞書 */
function readObjectCommon(o) {
  const { r, version, object } = o;
  if (version <= R14) setHandleStream(o, o.start + r.url());
  const reactors = r.bl();
  const noXdic = version >= R2004 ? r.bit() : 0;
  if (version >= R2013) r.bit();
  object.owner = o.hs.handle(object.handle);
  for (let i = 0; i < reactors; i++) o.hs.handle(object.handle);
  if (!noXdic) o.hs.handle();
}

/** 表の項目の名前と、外部参照の印（R2007+ は BS 1 つ、それより前は B・BS・B） */
function readTableName(o) {
  const name = o.r.text();
  if (o.version >= R2007) o.r.bs();
  else {
    o.r.bit();
    o.r.bs();
    o.r.bit();
  }
  return name;
}

const xy = (r) => r.rd2();
const xyz = (r) => r.bd3();

// ---- 図形 ----------------------------------------------------------------------------------------------------
function readText(o) {
  const { r, version, object } = o;
  if (version <= R14) {
    const elevation = r.bd();
    object.p = [...xy(r), elevation];
    object.align = [...xy(r), elevation];
    object.extrusion = r.bd3();
    object.thickness = r.bd();
    object.oblique = r.bd();
    object.rotation = r.bd();
    object.height = r.bd();
    object.widthFactor = r.bd();
    object.text = r.text();
    object.generation = r.bs();
    object.halign = r.bs();
    object.valign = r.bs();
  } else {
    const flags = r.byte();
    const elevation = flags & 1 ? 0 : r.rd();
    const p = xy(r);
    object.p = [...p, elevation];
    object.align = flags & 2 ? null : [r.dd(p[0]), r.dd(p[1]), elevation];
    object.extrusion = r.be();
    object.thickness = r.bt();
    object.oblique = flags & 4 ? 0 : r.rd();
    object.rotation = flags & 8 ? 0 : r.rd();
    object.height = r.rd();
    object.widthFactor = flags & 0x10 ? 1 : r.rd();
    object.text = r.text();
    object.generation = flags & 0x20 ? 0 : r.bs();
    object.halign = flags & 0x40 ? 0 : r.bs();
    object.valign = flags & 0x80 ? 0 : r.bs();
  }
  object.style = o.hs.handle();
}

function readAttrib(o) {
  readText(o);
  const { r, version, object } = o;
  if (version >= R2010) r.byte();
  const kind = version >= R2018 ? r.byte() : 1;
  if (kind === 2 || kind === 4) {
    // 複数行の属性（R2018+）: MTEXT が埋め込まれている。値はその MTEXT の文字列
    readEntityModeOnly(o);
    object.mtext = {};
    readMtextBody(o, object.mtext);
    const size = r.bs();
    if (size > 0) {
      r.skipBytes(size);
      o.hs.handle();
      r.bs();
    }
  }
  object.tag = r.text();
  r.bs();
  object.flags = r.byte();
  if (version >= R2007) r.bit();
}

function readAttdef(o) {
  readAttrib(o);
  if (o.version >= R2010) o.r.byte();
  o.object.prompt = o.r.text();
}

/** 埋め込みの MTEXT の図形の値（共通の図形の値のうち、図形の種類の印から先） */
function readEntityModeOnly(o) {
  const { r, version } = o;
  const hs = o.hs;
  const mode = r.bb();
  if (mode === 0) hs.handle();
  const reactors = r.bl();
  const noXdic = version >= R2004 ? r.bit() : 0;
  if (version >= R2013) r.bit();
  for (let i = 0; i < reactors; i++) hs.handle();
  if (!noXdic) hs.handle();
  const { book } = r.enc();
  if (book) hs.handle();
  r.bd();
  hs.handle();
  if (r.bb() === 3) hs.handle();
  const plot = r.bb();
  if (version >= R2007) {
    if (r.bb() === 3) hs.handle();
    r.byte();
  }
  if (plot === 3) hs.handle();
  if (version >= R2010) for (let i = 0; i < 3; i++) if (r.bit()) hs.handle();
  r.bs();
  r.byte();
}

function readBlock(o) {
  o.object.name = o.r.text();
}

function readInsert(o, multiple = false) {
  const { r, version, object } = o;
  object.p = xyz(r);
  if (version <= R14) object.scale = r.bd3();
  else {
    switch (r.bb()) {
      case 0: {
        const x = r.rd();
        object.scale = [x, r.dd(x), r.dd(x)];
        break;
      }
      case 1: object.scale = [1, r.dd(1), r.dd(1)]; break;
      case 2: {
        const s = r.rd();
        object.scale = [s, s, s];
        break;
      }
      default: object.scale = [1, 1, 1];
    }
  }
  object.rotation = r.bd();
  object.extrusion = r.bd3();
  const hasAttribs = r.bit();
  const owned = version >= R2004 && hasAttribs ? r.bl() : 0;
  if (multiple) {
    object.columns = r.bs();
    object.rows = r.bs();
    object.columnSpacing = r.bd();
    object.rowSpacing = r.bd();
  }
  object.block = o.hs.handle();
  object.attribs = [];
  if (!hasAttribs) return;
  if (version <= R2000) {
    object.firstAttrib = o.hs.handle();
    object.lastAttrib = o.hs.handle();
  } else for (let i = 0; i < owned; i++) object.attribs.push(o.hs.handle());
}

function readVertex2d(o) {
  const { r, version, object } = o;
  object.flags = r.byte();
  object.p = xyz(r);
  const start = r.bd();
  if (start < 0) object.widths = [-start, -start];
  else object.widths = [start, r.bd()];
  object.bulge = r.bd();
  if (version >= R2010) r.bl();
  object.tangent = r.bd();
}

function readVertex3d(o) {
  o.object.flags = o.r.byte();
  o.object.p = xyz(o.r);
}

function readPolyline2d(o) {
  const { r, version, object } = o;
  object.flags = r.bs();
  object.curveType = r.bs();
  object.widths = [r.bd(), r.bd()];
  object.thickness = r.bt();
  object.elevation = r.bd();
  object.extrusion = r.be();
  readPolylineChildren(o, version >= R2004 ? r.bl() : 0);
}

function readPolyline3d(o) {
  const { r, version, object } = o;
  object.splineFlags = r.byte();
  object.flags = r.byte() & 1 ? 1 | 8 : 8;
  readPolylineChildren(o, version >= R2004 ? r.bl() : 0);
}

function readPolylineMesh(o) {
  const { r, version, object } = o;
  object.flags = r.bs();
  r.bs(); // 曲面の種類
  object.m = r.bs();
  object.n = r.bs();
  r.bs();
  r.bs();
  readPolylineChildren(o, version >= R2004 ? r.bl() : 0);
}

function readPolylinePface(o) {
  const { r, version, object } = o;
  object.vertexCount = r.bs();
  object.faceCount = r.bs();
  readPolylineChildren(o, version >= R2004 ? r.bl() : 0);
}

function readPolylineChildren(o, owned) {
  const { version, object, hs } = o;
  object.vertices = [];
  if (version <= R2000) {
    object.firstVertex = hs.handle();
    object.lastVertex = hs.handle();
  } else for (let i = 0; i < owned; i++) object.vertices.push(hs.handle());
}

function readPfaceFace(o) {
  o.object.indices = [o.r.bs(), o.r.bs(), o.r.bs(), o.r.bs()];
}

function readArc(o) {
  const { r, object } = o;
  object.center = xyz(r);
  object.radius = r.bd();
  object.thickness = r.bt();
  object.extrusion = r.be();
  if (o.kind === "ARC") {
    object.start = r.bd();
    object.end = r.bd();
  }
}

function readLine(o) {
  const { r, version, object } = o;
  if (version <= R14) {
    object.a = xyz(r);
    object.b = xyz(r);
  } else {
    const flat = r.bit();
    const ax = r.rd(), bx = r.dd(ax), ay = r.rd(), by = r.dd(ay);
    const az = flat ? 0 : r.rd(), bz = flat ? 0 : r.dd(az);
    object.a = [ax, ay, az];
    object.b = [bx, by, bz];
  }
  object.thickness = r.bt();
  object.extrusion = r.be();
}

/** 寸法の共通の値（仕様書 20.4.22）。見た目は無名のブロック（*D…）にある */
function readDimensionCommon(o) {
  const { r, version, object } = o;
  if (version >= R2010) r.byte();
  object.extrusion = r.bd3();
  const mid = xy(r);
  const elevation = r.bd();
  object.textMid = [...mid, elevation];
  object.flags = r.byte();
  object.text = r.text();
  object.textRotation = r.bd();
  object.horizontal = r.bd();
  object.insertScale = r.bd3();
  object.insertRotation = r.bd();
  if (version >= R2000) {
    object.attach = r.bs();
    r.bs();
    r.bd();
    object.measurement = r.bd();
  }
  if (version >= R2007) {
    r.bit();
    r.bit();
    r.bit();
  }
  object.clonePoint = [...xy(r), elevation];
}

const DIMENSION_POINTS = {
  DIMENSION_ORDINATE: ["p10", "p13", "p14"],
  DIMENSION_LINEAR: ["p13", "p14", "p10"],
  DIMENSION_ALIGNED: ["p13", "p14", "p10"],
  DIMENSION_ANG3PT: ["p10", "p13", "p14", "p15"],
  DIMENSION_ANG2LN: ["p13", "p14", "p15", "p10"],
  DIMENSION_RADIUS: ["p10", "p15"],
  DIMENSION_DIAMETER: ["p15", "p10"],
};

function readDimension(o) {
  const { r, kind, object } = o;
  readDimensionCommon(o);
  if (kind === "DIMENSION_ANG2LN") object.p16 = xy(r);
  for (const name of DIMENSION_POINTS[kind]) object[name] = xyz(r);
  if (kind === "DIMENSION_ORDINATE") object.ordinateFlags = r.byte();
  if (kind === "DIMENSION_LINEAR" || kind === "DIMENSION_ALIGNED") object.extRotation = r.bd();
  if (kind === "DIMENSION_LINEAR") object.dimRotation = r.bd();
  if (kind === "DIMENSION_RADIUS" || kind === "DIMENSION_DIAMETER") object.leader = r.bd();
  object.dimstyle = o.hs.handle();
  object.block = o.hs.handle();
}

function readPoint(o) {
  const { r, object } = o;
  object.p = xyz(r);
  object.thickness = r.bt();
  object.extrusion = r.be();
}

function readFace3d(o) {
  const { r, version, object } = o;
  if (version <= R14) {
    object.points = [xyz(r), xyz(r), xyz(r), xyz(r)];
    object.invisibleEdges = r.bs();
    return;
  }
  const noFlags = r.bit(), flat = r.bit();
  const p1 = [r.rd(), r.rd(), flat ? 0 : r.rd()];
  const p2 = p1.map((v) => r.dd(v));
  const p3 = p2.map((v) => r.dd(v));
  const p4 = p3.map((v) => r.dd(v));
  object.points = [p1, p2, p3, p4];
  object.invisibleEdges = noFlags ? 0 : r.bs();
}

function readSolid(o) {
  const { r, object } = o;
  object.thickness = r.bt();
  const elevation = r.bd();
  object.points = [0, 1, 2, 3].map(() => [...xy(r), elevation]);
  object.extrusion = r.be();
}

function readEllipse(o) {
  const { r, object } = o;
  object.center = xyz(r);
  object.major = xyz(r);
  object.extrusion = xyz(r);
  object.ratio = r.bd();
  object.start = r.bd();
  object.end = r.bd();
}

function readSpline(o) {
  const { r, version, object } = o;
  let scenario = r.bl();
  if (version >= R2013) {
    const flags = r.bl();
    const knotParam = r.bl();
    object.knotParam = knotParam; // 通過点からノットを作る方法（0 弦の長さ・1 その平方根・2 等間隔・15 制御点で定義）
    object.closed = Boolean(flags & 4);
    scenario = knotParam === 15 || !(flags & 8) ? 1 : 2;
  }
  object.degree = r.bl();
  object.knots = [];
  object.controls = [];
  object.weights = [];
  object.fit = [];
  let knots = 0, controls = 0, fits = 0, weighted = false;
  if (scenario === 2) {
    object.fitTolerance = r.bd();
    object.startTangent = xyz(r);
    object.endTangent = xyz(r);
    fits = r.bl();
  } else {
    object.rational = Boolean(r.bit());
    object.closed = Boolean(r.bit()) || Boolean(object.closed);
    object.periodic = Boolean(r.bit());
    r.bd();
    r.bd();
    knots = r.bl();
    controls = r.bl();
    weighted = Boolean(r.bit());
  }
  for (let i = 0; i < knots; i++) object.knots.push(r.bd());
  for (let i = 0; i < controls; i++) {
    object.controls.push(xyz(r));
    if (weighted) object.weights.push(r.bd());
  }
  for (let i = 0; i < fits; i++) object.fit.push(xyz(r));
}

function readRay(o) {
  o.object.p = xyz(o.r);
  o.object.direction = xyz(o.r);
}

function readMtext(o) {
  readMtextBody(o, o.object);
}

/** MTEXT の本体（仕様書 20.4.46）。R2018 の注釈の値などは、要るところまで読む */
function readMtextBody(o, object) {
  const { r, version } = o;
  object.p = xyz(r);
  object.extrusion = xyz(r);
  object.direction = xyz(r);
  object.width = r.bd();
  if (version >= R2007) object.rectHeight = r.bd();
  object.height = r.bd();
  object.attach = r.bs();
  object.drawing = r.bs();
  r.bd();
  r.bd();
  object.text = r.text();
  object.style = o.hs.handle();
  if (version >= R2000) {
    r.bs();
    object.lineSpacing = r.bd();
    r.bit();
  }
}

function readLeader(o) {
  const { r, version, object } = o;
  r.bit();
  r.bs();
  object.pathType = r.bs(); // 0 = 直線、1 = スプライン
  const n = r.bl();
  object.points = [];
  for (let i = 0; i < n; i++) object.points.push(xyz(r));
  r.bd3();
  object.extrusion = r.bd3();
  r.bd3();
  r.bd3();
  if (version >= R14) r.bd3();
  if (version <= R14) r.bd();
  if (version <= R2007) {
    r.bd();
    r.bd();
  }
  r.bit();
  object.arrow = Boolean(r.bit());
}

function readLwpolyline(o) {
  const { r, version, object } = o;
  const flags = r.bs();
  object.closed = Boolean(flags & 0x200);
  object.constWidth = flags & 4 ? r.bd() : 0;
  object.elevation = flags & 8 ? r.bd() : 0;
  object.thickness = flags & 2 ? r.bd() : 0;
  object.extrusion = flags & 1 ? r.bd3() : [0, 0, 1];
  const n = r.bl();
  const bulges = flags & 0x10 ? r.bl() : 0;
  const ids = version >= R2010 && flags & 0x400 ? r.bl() : 0;
  const widths = flags & 0x20 ? r.bl() : 0;
  object.points = [];
  if (version <= R14) for (let i = 0; i < n; i++) object.points.push(xy(r));
  else if (n > 0) {
    let p = xy(r);
    object.points.push(p);
    for (let i = 1; i < n; i++) {
      p = r.dd2(p);
      object.points.push(p);
    }
  }
  object.bulges = [];
  for (let i = 0; i < bulges; i++) object.bulges.push(r.bd());
  for (let i = 0; i < ids; i++) r.bl();
  object.widths = [];
  for (let i = 0; i < widths; i++) object.widths.push([r.bd(), r.bd()]);
}

function readHatch(o) {
  const { r, version, object } = o;
  if (version >= R2004) {
    object.gradient = r.bl() !== 0;
    r.bl();
    r.bd();
    r.bd();
    r.bl();
    r.bd();
    const colors = r.bl();
    for (let i = 0; i < colors; i++) {
      r.bd();
      r.cmc();
    }
    r.text();
  }
  object.elevation = r.bd();
  object.extrusion = r.bd3();
  object.pattern = r.text();
  object.solid = Boolean(r.bit());
  r.bit();
  const paths = r.bl();
  object.loops = [];
  let derived = false;
  for (let i = 0; i < paths; i++) {
    const flags = r.bl();
    if (flags & 4) derived = true;
    const loop = { flags, edges: [] };
    if (!(flags & 2)) {
      const n = r.bl();
      for (let j = 0; j < n; j++) loop.edges.push(readHatchEdge(r, version));
    } else {
      const bulged = r.bit();
      loop.closed = Boolean(r.bit());
      const n = r.bl();
      loop.points = [];
      loop.bulges = [];
      for (let j = 0; j < n; j++) {
        loop.points.push(xy(r));
        loop.bulges.push(bulged ? r.bd() : 0);
      }
    }
    const handles = r.bl();
    for (let j = 0; j < handles; j++) o.hs.handle();
    object.loops.push(loop);
  }
  object.style = r.bs();
  r.bs();
  object.lines = [];
  if (!object.solid) {
    object.angle = r.bd();
    object.scale = r.bd();
    r.bit();
    const n = r.bs();
    for (let i = 0; i < n; i++) {
      const line = { angle: r.bd(), base: r.bd2(), offset: r.bd2(), dashes: [] };
      const dashes = r.bs();
      for (let j = 0; j < dashes; j++) line.dashes.push(r.bd());
      object.lines.push(line);
    }
  }
  if (derived) r.bd();
}

function readHatchEdge(r, version) {
  const kind = r.byte();
  switch (kind) {
    case 1: return { kind: "line", a: xy(r), b: xy(r) };
    case 2: return { kind: "arc", center: xy(r), radius: r.bd(), start: r.bd(), end: r.bd(), ccw: Boolean(r.bit()) };
    case 3: return { kind: "ellipse", center: xy(r), major: xy(r), ratio: r.bd(), start: r.bd(), end: r.bd(), ccw: Boolean(r.bit()) };
    case 4: {
      const edge = { kind: "spline", degree: r.bl(), rational: Boolean(r.bit()), periodic: Boolean(r.bit()), knots: [], controls: [], weights: [], fit: [] };
      const knots = r.bl(), controls = r.bl();
      for (let i = 0; i < knots; i++) edge.knots.push(r.bd());
      for (let i = 0; i < controls; i++) {
        edge.controls.push(xy(r));
        if (edge.rational) edge.weights.push(r.bd());
      }
      if (version >= R2010) {
        const fits = r.bl();
        for (let i = 0; i < fits; i++) edge.fit.push(xy(r));
        if (fits > 0) {
          xy(r);
          xy(r);
        }
      }
      return edge;
    }
    default: throw new DwgError(`ハッチの境界の種類 ${kind} が分かりません。`);
  }
}

function readViewport(o) {
  const { r, object } = o;
  object.center = xyz(r);
  object.width = r.bd();
  object.height = r.bd();
  if (o.version >= R2000) {
    object.viewTarget = xyz(r);
    object.viewDirection = xyz(r);
    object.twist = r.bd();
    object.viewHeight = r.bd();
    r.bd(); // レンズ
    r.bd();
    r.bd();
    r.bd();
    object.viewCenter = r.rd2();
  }
}

// ---- 表・そのほかのオブジェクト ---------------------------------------------------------------------------------
function readBlockHeader(o) {
  const { r, version, object, hs } = o;
  object.name = readTableName(o);
  object.anonymous = Boolean(r.bit());
  r.bit(); // 属性定義あり
  object.xref = Boolean(r.bit());
  object.overlay = Boolean(r.bit());
  if (version >= R2000) r.bit();
  const owned = version >= R2004 && !object.xref && !object.overlay ? r.bl() : 0;
  object.base = xyz(r);
  object.xrefPath = r.text();
  let inserts = 0;
  if (version >= R2000) {
    while (r.byte()) inserts++;
    object.description = r.text();
    const preview = r.bl();
    if (preview > 0) r.skipBytes(preview);
  }
  if (version >= R2007) {
    object.units = r.bs();
    r.bit();
    r.byte();
  }
  hs.handle(); // NULL
  object.blockEntity = hs.handle();
  object.entities = [];
  if (version <= R2000 && !object.xref && !object.overlay) {
    object.firstEntity = hs.handle();
    object.lastEntity = hs.handle();
  }
  for (let i = 0; i < owned; i++) object.entities.push(hs.handle());
  object.endBlock = hs.handle();
  if (version >= R2000) {
    for (let i = 0; i < inserts; i++) hs.handle();
    object.layout = hs.handle();
  }
}

function readLayer(o) {
  const { r, version, object, hs } = o;
  object.name = readTableName(o);
  let flags;
  if (version <= R14) {
    const frozen = r.bit(), on = r.bit(), frozenNew = r.bit(), locked = r.bit();
    flags = (frozen ? 1 : 0) | (on ? 0 : 2) | (frozenNew ? 4 : 0) | (locked ? 8 : 0) | 16;
    object.lineweight = -3;
  } else {
    flags = r.bs();
    object.lineweight = lineweight((flags & 0x3e0) >> 5);
  }
  object.frozen = Boolean(flags & 1);
  object.off = Boolean(flags & 2);
  object.locked = Boolean(flags & 8);
  object.plot = Boolean(flags & 16);
  object.color = r.cmc();
  hs.handle(); // 外部参照のブロック
  if (version >= R2000) hs.handle(); // 印刷スタイル
  if (version >= R2007) hs.handle(); // 材料
  object.ltype = hs.handle();
}

function readStyle(o) {
  const { r, object } = o;
  object.name = readTableName(o);
  object.vertical = Boolean(r.bit());
  object.shape = Boolean(r.bit());
  object.height = r.bd();
  object.widthFactor = r.bd();
  object.oblique = r.bd();
  object.generation = r.byte();
  r.bd();
  object.font = r.text();
  object.bigFont = r.text();
}

function readLtype(o) {
  const { r, object } = o;
  object.name = readTableName(o);
  object.description = r.text();
  object.length = r.bd();
  r.byte(); // 揃え（'A'）
  const n = r.byte();
  object.dashes = [];
  for (let i = 0; i < n; i++) {
    const length = r.bd();
    r.bs(); // 形の番号
    r.rd(); // x のずれ
    r.rd(); // y のずれ
    r.bd(); // 尺度
    r.bd(); // 回転
    r.bs(); // 形・文字の印
    object.dashes.push(length);
  }
}

function readLayout(o) {
  const { r, version, object, hs } = o;
  // 印刷の設定（PLOTSETTINGS）
  r.text();
  r.text();
  r.bs();
  for (let i = 0; i < 6; i++) r.bd();
  r.text();
  r.bd();
  r.bd();
  r.bs();
  r.bs();
  r.bs();
  for (let i = 0; i < 4; i++) r.bd();
  if (version <= R2000) r.text();
  r.bd();
  r.bd();
  r.text();
  r.bs();
  r.bd();
  r.bd2();
  if (version >= R2004) {
    r.bs();
    r.bs();
    r.bs();
    hs.handle();
  }
  if (version >= R2007) hs.handle();
  // レイアウト
  object.name = r.text();
  object.tabOrder = r.bl();
  object.flags = r.bs();
  r.bd3();
  object.limits = [r.rd2(), r.rd2()];
  r.bd3();
  r.bd3();
  r.bd3();
  r.bd();
  r.bs();
  object.extents = [r.bd3(), r.bd3()];
  const viewports = version >= R2004 ? r.bl() : 0;
  object.block = hs.handle();
  object.activeViewport = hs.handle();
  hs.handle();
  hs.handle();
  object.viewports = [];
  for (let i = 0; i < viewports; i++) object.viewports.push(hs.handle());
}

/** DBCOLOR: 色見本帳の色（名前つきの色。図形の ENC が指す） */
function readDbColor(o) {
  o.object.color = o.r.cmc();
}

function readDictionary(o) {
  const { r, version, object, hs } = o;
  const n = r.bl();
  if (version === R14) r.byte();
  if (version >= R2000) {
    r.bs();
    r.byte();
  }
  object.entries = [];
  for (let i = 0; i < n; i++) object.entries.push([r.text(), 0]);
  for (const entry of object.entries) entry[1] = hs.handle();
}

const READERS = {
  TEXT: readText, ATTRIB: readAttrib, ATTDEF: readAttdef, BLOCK: readBlock,
  INSERT: (o) => readInsert(o), MINSERT: (o) => readInsert(o, true),
  VERTEX_2D: readVertex2d, VERTEX_3D: readVertex3d, VERTEX_MESH: readVertex3d, VERTEX_PFACE: readVertex3d, VERTEX_PFACE_FACE: readPfaceFace,
  POLYLINE_2D: readPolyline2d, POLYLINE_3D: readPolyline3d, POLYLINE_MESH: readPolylineMesh, POLYLINE_PFACE: readPolylinePface,
  ARC: readArc, CIRCLE: readArc, LINE: readLine, POINT: readPoint, "3DFACE": readFace3d, SOLID: readSolid, TRACE: readSolid,
  ELLIPSE: readEllipse, SPLINE: readSpline, RAY: readRay, XLINE: readRay, MTEXT: readMtext, LEADER: readLeader,
  LWPOLYLINE: readLwpolyline, HATCH: readHatch, VIEWPORT: readViewport,
  BLOCK_HEADER: readBlockHeader, LAYER: readLayer, STYLE: readStyle, LTYPE: readLtype, LAYOUT: readLayout, DICTIONARY: readDictionary,
  DBCOLOR: readDbColor,
  ENDBLK: () => {}, SEQEND: () => {},
};
for (const kind of Object.keys(DIMENSION_POINTS)) READERS[kind] = readDimension;

