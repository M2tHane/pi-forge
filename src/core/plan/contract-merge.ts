// 契约文件的结构化三方合并（规格第 12.2 节）。纯函数，不读写文件。
// 只在双方都"仅追加"（新增映射键 / Markdown 小节，不改动 base 已有内容）且新增内容互不冲突时自动合并；否则给出中文原因，交给 merge-fix。
import { parseDocument, isMap, isScalar, YAMLMap, type Document, type Pair } from 'yaml';
import { isDeepStrictEqual } from 'node:util';

export type MergeOutcome = { ok: true; text: string } | { ok: false; reason: string };

export function mergeContractThreeWay(rel: string, base: string, ours: string, theirs: string): MergeOutcome {
  if (ours === theirs) return { ok: true, text: ours };
  if (/\.ya?ml$/i.test(rel)) return mergeYaml(base, ours, theirs);
  if (/\.md$/i.test(rel)) return mergeMarkdown(base, ours, theirs);
  return { ok: false, reason: `${rel} 不是 YAML 或 Markdown 文件，不支持结构化合并` };
}

// ---------- YAML ----------

type Fail = { fail: string };
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && 'fail' in x;

function load(text: string, who: string): Document | Fail {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { fail: `${who} 不是合法的 YAML：${doc.errors[0]!.message.split('\n')[0]}` };
  return doc;
}

function mergeYaml(base: string, ours: string, theirs: string): MergeOutcome {
  const b = load(base, 'base');
  const o = load(ours, 'ours（集成分支）');
  const t = load(theirs, 'theirs（任务）');
  for (const d of [b, o, t]) if (isFail(d)) return { ok: false, reason: d.fail };
  const [bd, od, td] = [b, o, t] as Document[];
  // 一方没有改动：直接取另一方
  if (isDeepStrictEqual(bd.toJS(), td.toJS())) return { ok: true, text: ours };
  if (isDeepStrictEqual(bd.toJS(), od.toJS())) return { ok: true, text: theirs };
  if (!isMap(bd.contents) || !isMap(od.contents) || !isMap(td.contents)) return { ok: false, reason: '文件顶层不是映射，无法结构化合并' };
  const err = mergeMaps('', bd.contents, od.contents, td.contents);
  if (err) return { ok: false, reason: err };
  return { ok: true, text: od.toString() };
}

const keyOf = (p: Pair): string => String(isScalar(p.key) ? p.key.value : p.key);
const at = (prefix: string, k: string) => (prefix ? `${prefix}.${k}` : k);

function toJS(n: unknown): unknown {
  if (n && typeof n === 'object' && 'toJSON' in n && typeof (n as { toJSON: () => unknown }).toJSON === 'function') return (n as { toJSON: () => unknown }).toJSON();
  return n;
}

/** 把 theirs 新增的键追加进 ours（就地修改 ours）；返回错误原因，没有冲突时返回 null */
function mergeMaps(prefix: string, b: YAMLMap, o: YAMLMap, t: YAMLMap): string | null {
  const find = (m: YAMLMap, k: string) => m.items.find((p) => keyOf(p) === k);
  // 1. base 已有的键：双方都不能删除或修改（映射可以递归）
  for (const bp of b.items) {
    const k = keyOf(bp);
    const op = find(o, k);
    const tp = find(t, k);
    if (!op) return `ours 删除了已有的 ${at(prefix, k)}`;
    if (!tp) return `theirs 删除了已有的 ${at(prefix, k)}`;
    const bv = bp.value;
    const ov = op.value;
    const tv = tp.value;
    if (isMap(bv) && isMap(ov) && isMap(tv)) {
      const e = mergeMaps(at(prefix, k), bv, ov, tv);
      if (e) return e;
      continue;
    }
    const bj = toJS(bv);
    // base 里是空值（如 `paths:`），双方都往里新增 → 按空映射递归
    if ((bj === null || bj === undefined) && isMap(ov) && isMap(tv)) {
      const e = mergeMaps(at(prefix, k), new YAMLMap(), ov, tv);
      if (e) return e;
      continue;
    }
    if (!isDeepStrictEqual(toJS(ov), bj)) return `ours 修改了已有的 ${at(prefix, k)}`;
    if (!isDeepStrictEqual(toJS(tv), bj)) {
      // 例外：base 里是空值（如 `paths:`），theirs 往里新增 → 整体取 theirs 的值
      if ((bj === null || bj === undefined) && isMap(tv)) { op.value = tp.clone().value; continue; }
      return `theirs 修改了已有的 ${at(prefix, k)}`;
    }
  }
  // 2. theirs 新增的键：ours 没有则追加到末尾；双方都新增则必须完全相同
  for (const tp of t.items) {
    const k = keyOf(tp);
    if (find(b, k)) continue;
    const op = find(o, k);
    if (!op) { o.items.push(tp.clone() as Pair); continue; }
    if (!isDeepStrictEqual(toJS(op.value), toJS(tp.value))) return `双方都新增了 ${at(prefix, k)}，且内容不同`;
  }
  return null;
}

// ---------- Markdown ----------

interface MdParts { preamble: string; sections: { name: string; text: string }[] }

function splitMarkdown(text: string): MdParts {
  const lines = text.split('\n');
  const parts: MdParts = { preamble: '', sections: [] };
  let cur: string[] = [];
  let name: string | null = null;
  let fence = false;
  const flush = () => { if (name === null) parts.preamble = cur.join('\n'); else parts.sections.push({ name, text: cur.join('\n') }); };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (m) { flush(); name = m[1]!; cur = [line]; } else cur.push(line);
  }
  flush();
  return parts;
}

function mergeMarkdown(base: string, ours: string, theirs: string): MergeOutcome {
  const b = splitMarkdown(base);
  const o = splitMarkdown(ours);
  const t = splitMarkdown(theirs);
  const norm = (s: string) => s.trimEnd();
  const sec = (p: MdParts, n: string) => p.sections.find((s) => s.name === n);
  if (norm(o.preamble) !== norm(b.preamble)) return { ok: false, reason: 'ours 修改了小节之前的内容' };
  if (norm(t.preamble) !== norm(b.preamble)) return { ok: false, reason: 'theirs 修改了小节之前的内容' };
  for (const bs of b.sections) {
    const os = sec(o, bs.name);
    const ts = sec(t, bs.name);
    if (!os) return { ok: false, reason: `ours 删除了已有的小节「${bs.name}」` };
    if (!ts) return { ok: false, reason: `theirs 删除了已有的小节「${bs.name}」` };
    if (norm(os.text) !== norm(bs.text)) return { ok: false, reason: `ours 修改了已有的小节「${bs.name}」` };
    if (norm(ts.text) !== norm(bs.text)) return { ok: false, reason: `theirs 修改了已有的小节「${bs.name}」` };
  }
  let text = ours;
  for (const ts of t.sections) {
    if (sec(b, ts.name)) continue;
    const os = sec(o, ts.name);
    if (os) {
      if (norm(os.text) !== norm(ts.text)) return { ok: false, reason: `双方都新增了小节「${ts.name}」，且内容不同` };
      continue;
    }
    text = `${text.replace(/\n*$/, '')}\n\n${norm(ts.text)}\n`;
  }
  return { ok: true, text };
}
