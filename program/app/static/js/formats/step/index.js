// STEP 解析の入口。部品（形状を持つ製品）と、組立の中の出現（配置）を読む。
//   parseStepFile(text, name) → { report, scene }
//   scene … { file, units: "mm", kind: "assembly", source, labels, parts, instances }
//     parts[i]     … { id, name, number, material, density_g_per_mm3, bodies: [{ faces, edges, summary }] }
//     instances[i] … { id, part（parts の番号）, name, path, matrix（4×4 行優先、mm） }
// 形状の要約・面の書き出しは ipt と同じ処理（formats/acis/brep.js・scene.js）を使う。

import labels from "../../core/labels.json" with { type: "json" };
import { exportFace, mm as toMm } from "../../model/scene.js";
import { multiply, placementMatrix, invert, IDENTITY } from "../../core/matrix.js";
import { StepGeometry, summarizeSolid, unitsOf } from "./brep.js";
import { argsOf, isType, parseStep } from "./p21.js";

export { StepError } from "./p21.js";

const SOLID_TYPES = new Set(["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "SHELL_BASED_SURFACE_MODEL"]);

/** 表現（REPRESENTATION）の引数: [名前, 要素, 文脈] */
const repArgs = (step, ref) => {
  const e = step.get(ref);
  return e?.args ?? e?.parts?.find((p) => p.args.length === 3 && Array.isArray(p.args[1]))?.args ?? null;
};

function readStructure(step) {
  const products = new Map(); // PRODUCT_DEFINITION → { id, name }
  const pdsOf = new Map(); // PRODUCT_DEFINITION_SHAPE → 定義（PD または NAUO）
  const repOfDefinition = new Map(); // 定義 → SHAPE_REPRESENTATION
  const linked = new Map(); // 表現 → 変換なしでつながる表現
  const nauos = [];
  const cdsr = new Map(); // NAUO → { rep1, rep2, item1, item2 }
  const props = new Map(); // PD → { material, density }
  const link = (a, b) => {
    if (!linked.has(a)) linked.set(a, []);
    linked.get(a).push(b);
  };
  for (const e of step.records.values()) {
    switch (e.type) {
      case "PRODUCT_DEFINITION": {
        const formation = step.get(e.args[2]);
        const product = step.get(formation?.args[2]);
        products.set(e.id, { id: product?.args[0] ?? "", name: product?.args[1] || product?.args[0] || `#${e.id}` });
        break;
      }
      case "PRODUCT_DEFINITION_SHAPE":
        pdsOf.set(e.id, e.args[2]?.ref);
        break;
      case "NEXT_ASSEMBLY_USAGE_OCCURRENCE":
        nauos.push({ id: e.id, name: e.args[1] || e.args[0], parent: e.args[3].ref, child: e.args[4].ref });
        break;
      case "SHAPE_REPRESENTATION_RELATIONSHIP":
        link(e.args[2].ref, e.args[3].ref);
        link(e.args[3].ref, e.args[2].ref);
        break;
      default:
        break;
    }
  }
  for (const e of step.records.values()) {
    if (e.type === "SHAPE_DEFINITION_REPRESENTATION") {
      repOfDefinition.set(pdsOf.get(e.args[0].ref), e.args[1].ref);
    } else if (e.type === "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION") {
      const rel = step.get(e.args[0]);
      const rr = argsOf(rel, "REPRESENTATION_RELATIONSHIP");
      const tr = argsOf(rel, "REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION");
      const idt = step.get(tr?.[0]);
      if (rr && idt?.type === "ITEM_DEFINED_TRANSFORMATION") {
        cdsr.set(pdsOf.get(e.args[1].ref), { rep1: rr[2].ref, rep2: rr[3].ref, item1: idt.args[2], item2: idt.args[3] });
      }
    } else if (e.type === "PROPERTY_DEFINITION_REPRESENTATION") {
      const pd = step.get(e.args[0]);
      const rep = repArgs(step, e.args[1]);
      if (pd?.type !== "PROPERTY_DEFINITION" || !rep) continue;
      const target = pd.args[2]?.ref;
      if (!props.has(target)) props.set(target, {});
      for (const item of rep[1].map((r) => step.get(r))) {
        if (item?.type === "DESCRIPTIVE_REPRESENTATION_ITEM" && /material/i.test(pd.args[0] ?? "") && /name/i.test(pd.args[1] ?? "")) props.get(target).material = item.args[1] || item.args[0];
        if (item?.type === "MEASURE_REPRESENTATION_ITEM" && /density/i.test(item.args[0] ?? "")) {
          props.get(target).density = { value: item.args[1]?.args?.[0], unit: item.args[2] };
        }
      }
    }
  }
  return { products, repOfDefinition, linked, nauos, cdsr, props };
}

/** 表現につながる全てのソリッド（変換なしの関係をたどる） */
function solidsOf(step, rep, linked) {
  const out = [], seen = new Set();
  const visit = (r) => {
    if (seen.has(r)) return;
    seen.add(r);
    for (const item of repArgs(step, r)?.[1] ?? []) {
      const e = step.get(item);
      if (e && SOLID_TYPES.has(e.type)) out.push({ ref: item.ref, context: repArgs(step, r)[2] });
    }
    for (const next of linked.get(r) ?? []) visit(next);
  };
  visit(rep);
  return out;
}

/** 密度を g/mm³ にする（質量 = 体積 mm³ × これ）。単位が読めなければ g/cm³ とみなさず null */
function densityPerMm3(step, density) {
  if (typeof density?.value !== "number") return null;
  const unit = step.get(density.unit);
  const elements = unit?.type === "DERIVED_UNIT" ? unit.args[0].map((r) => step.get(r)) : [];
  let factor = 1, mass = false, volume = false;
  for (const el of elements) {
    const u = step.get(el.args[0]), exp = el.args[1];
    if (isType(u, "MASS_UNIT")) {
      const conv = argsOf(u, "CONVERSION_BASED_UNIT");
      const si = argsOf(u, "SI_UNIT");
      const grams = conv && /^gram$/i.test(conv[0]) ? 1 : si?.[1]?.enum === "GRAM" ? ({ KILO: 1000, MILLI: 1e-3 }[si[0]?.enum] ?? 1) : null;
      if (grams === null) return null;
      factor *= grams ** exp;
      mass = true;
    } else if (isType(u, "LENGTH_UNIT")) {
      const si = argsOf(u, "SI_UNIT");
      if (si?.[1]?.enum !== "METRE") return null;
      const perMm = ({ CENTI: 10, MILLI: 1, DECI: 100 }[si[0]?.enum] ?? (si[0] ? null : 1000));
      if (perMm === null) return null;
      factor *= perMm ** exp;
      volume = exp === -3;
    }
  }
  return mass && volume ? density.value * factor : null;
}

/**
 * @param {string} text  STEP ファイルの中身
 * @param {string} name  ファイル名（表示用）
 */
export function parseStepFile(text, name) {
  const step = parseStep(text);
  const { products, repOfDefinition, linked, nauos, cdsr, props } = readStructure(step);
  const unitsCache = new Map();
  const units = (context) => {
    const key = context?.ref;
    if (!unitsCache.has(key)) unitsCache.set(key, unitsOf(step, context));
    return unitsCache.get(key);
  };
  const repUnits = (rep) => units(repArgs(step, rep)?.[2]);

  // 部品（形状を持つ製品定義）
  const parts = [], partOf = new Map();
  for (const [pd, product] of products) {
    const rep = repOfDefinition.get(pd);
    const solids = rep ? solidsOf(step, rep, linked) : [];
    if (!solids.length) continue;
    const bodies = solids.map(({ ref, context }) => {
      const u = units(context);
      const solid = new StepGeometry(step, u).solid(ref);
      const edges = new Map(solid.faces.flatMap((f) => f.edges.map((e) => [e.index, e])));
      return {
        faces: solid.faces.map((f) => exportFace(f, u.mm)),
        edges: [...edges.values()].filter((e) => !e.seam).map((e) => e.points.map((p) => toMm(p, u.mm))),
        summary: summarizeSolid(solid, u.mm),
      };
    });
    const prop = props.get(pd) ?? {};
    partOf.set(pd, parts.length);
    parts.push({ id: pd, name: product.name, number: product.id, material: prop.material ?? null, density_g_per_mm3: densityPerMm3(step, prop.density), bodies });
  }

  // 出現（組立の木をたどり、部品ごとの配置を求める。変換は「親の表現の置き方 × 子の表現の置き方の逆」）
  const childrenOf = new Map();
  for (const n of nauos) {
    if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
    childrenOf.get(n.parent).push(n);
  }
  const isChild = new Set(nauos.map((n) => n.child));
  const roots = [...products.keys()].filter((pd) => !isChild.has(pd) && (childrenOf.has(pd) || partOf.has(pd)));
  const instances = [];
  const place = (pd, matrix, path, depth) => {
    if (depth > 32) return; // 循環の防止
    if (partOf.has(pd)) instances.push({ id: instances.length, part: partOf.get(pd), name: path.at(-1) ?? products.get(pd).name, path, matrix });
    for (const n of childrenOf.get(pd) ?? []) {
      const rel = cdsr.get(n.id);
      let local = IDENTITY;
      if (rel) {
        const childRep = repOfDefinition.get(n.child);
        const [childItem, parentItem, parentRep] = rel.rep1 === childRep ? [rel.item1, rel.item2, rel.rep2] : [rel.item2, rel.item1, rel.rep1];
        const geo = new StepGeometry(step);
        const scale = repUnits(parentRep).mm;
        local = multiply(placementMatrix(geo.placement(parentItem), scale), invert(placementMatrix(geo.placement(childItem), scale)));
      }
      place(n.child, multiply(matrix, local), [...path, n.name], depth + 1);
    }
  };
  for (const root of roots) place(root, IDENTITY, [], 0);

  const rootName = roots.length === 1 && childrenOf.has(roots[0]) ? products.get(roots[0]).name : null;
  const scene = {
    file: name,
    units: "mm",
    kind: "assembly",
    source: { format: "STEP", schema: step.header.schema ?? "", system: step.header.system ?? "", time: step.header.time ?? "", author: step.header.author ?? "" },
    labels,
    root: rootName,
    parts,
    instances,
  };
  const report = {
    file: { name, size: text.length },
    header: step.header,
    entities: step.records.size,
    products: products.size,
    parts: parts.map((p) => ({ name: p.name, number: p.number, material: p.material, bodies: p.bodies.map((b) => b.summary) })),
    occurrences: nauos.length,
  };
  return { report, scene };
}
