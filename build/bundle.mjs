#!/usr/bin/env node
/**
 * Bundle the plugin's client half into the DSH ModuleLoader factory format.
 *
 * DSH serves `lib/client.js` and evaluates it where `window.__ModuleLoader__` is
 * defined. The recognised shape is:
 *
 *   window.__ModuleLoader__.load({
 *     id: '<package name>',
 *     factory: (require) => { ...; return module.exports; }
 *   });
 *
 * `require` resolves bare specifiers against the shell's frozen platform table
 * (react, react/jsx-runtime, react-dom, @deepseek-ai/dsh-client-ui-*), so the
 * bundler inlines every relative import and lets bare ones fall through.
 *
 * Strategy: scan the source with a comment/string MASK (same length as the
 * original, so indices line up), record span edits, then rebuild the file in one
 * pass. Anything not understood throws, so a missed construct cannot silently
 * ship broken code.
 *
 *   node build/bundle.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src/client/index.js');
const OUT = join(ROOT, 'lib/client.js');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/* ------------------------------------------------------------------ *
 * comment / string masking (same length as input)
 * ------------------------------------------------------------------ */
/**
 * Comment / string masking.
 *
 * The result has the SAME length as the input so every index in `masked` is also
 * valid in the original source. Comments are blanked. String and template
 * literals keep their DELIMITERS and their CONTENT (so `from 'react'` still reads
 * as a specifier) but any comment-looking text inside them no longer confuses the
 * scanners. Nothing in this plugin embeds a `//` or `/*` sequence inside a string
 * literal used as a specifier, and the leftover-export check runs on the masked
 * text, so keeping contents is safe and much simpler than blanking them.
 */
function mask(source) {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/* ------------------------------------------------------------------ *
 * per-file transform
 * ------------------------------------------------------------------ */
/**
 * End index of the statement starting at `start`.
 *
 * Tracks bracket depth so a multi-line object/array initialiser is not cut in
 * half, and treats a newline as the end only when brackets are balanced and the
 * line does not continue with an operator or an opening bracket.
 */
function findStatementEnd(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (ch === ';' && depth <= 0) return i + 1;
    if (ch === '\n' && depth <= 0) {
      // does the next non-empty line continue this statement?
      const rest = src.slice(i + 1);
      const nextLine = rest.match(/^[ \t]*([^\n]*)/);
      const next = nextLine ? nextLine[1].trim() : '';
      if (next === '' && !/;\s*$/.test(src.slice(start, i))) return i + 1;  // blank line ends it
      if (/^[.)\]},;]/.test(next) || /^[+\-*/%&|?:]/.test(next)) continue;   // continuation
      return i + 1;
    }
  }
  return src.length;
}

/**
 * @param {string} src
 * @param {string} fileId
 * @param {(spec:string)=>string} resolveSpec
 */
function transform(src, fileId, resolveSpec) {
  const masked = mask(src);
  const edits = [];
  const deferred = [];
  let importSeq = 0;

  /* ---- imports ---- */
  // NOTE: group layout is (1) leading newline (2) clause (3) quote (4) specifier
  const IMPORT_RE = /(^|\n)[ \t]*import[ \t]+([\s\S]*?)[ \t]*from[ \t]*(['"])([^'"]+)\3[ \t]*;?[ \t]*(?=\r?\n|$)/g;
  const BARE_RE = /(^|\n)[ \t]*import[ \t]*(['"])([^'"]+)\2[ \t]*;?[ \t]*(?=\r?\n|$)/g;
  const importRanges = [];
  let m;
  while ((m = IMPORT_RE.exec(masked))) {
    const stmtStart = m.index + m[1].length;
    const end = findStatementEnd(src, stmtStart);
    const clause = m[2].trim();
    const spec = m[4];
    importRanges.push([stmtStart, end]);
    edits.push({ start: stmtStart, end, text: buildImport({ clause, spec, seq: importSeq++ }, resolveSpec, fileId) });
  }
  while ((m = BARE_RE.exec(masked))) {
    const stmtStart = m.index + m[1].length;
    if (importRanges.some(([s, e]) => stmtStart >= s && stmtStart < e)) continue;
    const end = findStatementEnd(src, stmtStart);
    edits.push({ start: stmtStart, end, text: `require(${JSON.stringify(resolveSpec(m[3]))});` });
  }

  /* ---- exports ---- */
  const EXPORT_RE = /(^|\n)[ \t]*export[ \t]+/g;
  const exportRanges = [];
  while ((m = EXPORT_RE.exec(masked))) {
    const stmtStart = m.index + m[1].length;
    if (importRanges.some(([s, e]) => stmtStart >= s && stmtStart < e)) continue;
    if(exportRanges.some(([s,e]) => stmtStart >= s && stmtStart < e)) continue;
    const afterIdx = stmtStart + 'export '.length;
    const after = masked.slice(afterIdx);

    let end = findStatementEnd(src, stmtStart);
    exportRanges.push([stmtStart, end]);

    if (/^default[ \t]/.test(after)) {
      // `export default <expr>;`
      edits.push({ start: stmtStart, end: stmtStart + 'export default '.length, text: 'exports.default = ' });
      continue;
    }
    if (/^\{/.test(after)) {
      // `export { a, b as c };`
      const close = masked.indexOf('}', afterIdx);
      const inner = src.slice(afterIdx + 1, close);
      const names = inner.split(',').map((p) => p.trim()).filter(Boolean).map((t) => {
        const asMatch = /^([A-Za-z_$][\w$]*)[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(t);
        return asMatch ? { local: asMatch[1], exported: asMatch[2] } : { local: t, exported: t };
      });
      edits.push({ start: stmtStart, end, text: names.map((n) => `exports[${JSON.stringify(n.exported)}] = ${n.local};`).join(' ') });
      continue;
    }
    const declMatch = /^(async[ \t]+function|function|class|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/.exec(after);
    if (declMatch) {
      const name = declMatch[2];
      if (declMatch[1] === 'function' || declMatch[1] === 'class' || declMatch[1] === 'async function') {
        // hoisted: strip keyword, export at the end
        edits.push({ start: stmtStart, end: stmtStart + 'export '.length, text: '' });
        deferred.push(name);
      } else {
        // const/let/var are in TDZ before their declaration, so export at the end
        edits.push({ start: stmtStart, end: stmtStart + 'export '.length, text: '' });
        deferred.push(name);
      }
      continue;
    }
    // `export * from '...'` is intentionally unsupported
    throw new Error(`${fileId}: unsupported export form: ${JSON.stringify(src.slice(stmtStart, Math.min(end, stmtStart + 60)))}`);
  }

  /* ---- rebuild ---- */
  const sorted = edits.slice().sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const e of sorted) {
    if (e.start < cursor) throw new Error(`${fileId}: overlapping edit at ${e.start}`);
    out += src.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += src.slice(cursor);

  const tail = deferred.length ? '\n' + deferred.map((n) => `exports.${n} = ${n};`).join('\n') + '\n' : '';
  return { code: out + tail, deferred };
}

function buildImport({ clause, spec, seq }, resolveSpec, fileId) {
  const target = resolveSpec(spec);
  const req = `__mod${seq}`;
  let s = `var ${req} = require(${JSON.stringify(target)});`;
  let rest = clause;
  const named = [];
  const braceIdx = rest.indexOf('{');
  if (braceIdx !== -1) {
    const braceEnd = rest.lastIndexOf('}');
    const inner = rest.slice(braceIdx + 1, braceEnd);
    for (const part of inner.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(t);
      named.push(asMatch ? { imported: asMatch[1], local: asMatch[2] } : { imported: t, local: t });
    }
    rest = (rest.slice(0, braceIdx) + rest.slice(braceEnd + 1)).trim();
  }
  if (rest) {
    if (rest.startsWith('*')) {
      const nsMatch = /^\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(rest);
      if (!nsMatch) throw new Error(`${fileId}: unsupported namespace import: ${clause}`);
      s += ` var ${nsMatch[1]} = ${req};`;
    } else {
      const def = rest.replace(/,$/, '').trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(def)) throw new Error(`${fileId}: unsupported import clause: ${clause}`);
      s += ` var ${def} = (${req} && ${req}.__esModule) ? ${req}.default : (${req}.default !== void 0 ? ${req}.default : ${req});`;
    }
  }
  for (const nm of named) s += ` var ${nm.local} = ${req}[${JSON.stringify(nm.imported)}];`;
  return s;
}

/* ------------------------------------------------------------------ *
 * module graph
 * ------------------------------------------------------------------ */
const modules = new Map();

function moduleId(abs) {
  return relative(ROOT, abs).replace(/\\/g, '/');
}

function loadModule(abs) {
  const id = moduleId(abs);
  if (modules.has(abs)) return id;
  modules.set(abs, { id, code: null });

  if (abs.endsWith('.json')) {
    const json = readFileSync(abs, 'utf8');
    modules.set(abs, { id, code: `module.exports = ${json.trim()};\n`, json: true });
    return id;
  }

  const src = readFileSync(abs, 'utf8');
  const resolveSpec = (spec) => {
    if (spec.startsWith('.')) {
      let target = resolve(dirname(abs), spec);
      if (!existsSync(target) && existsSync(target + '.js')) target += '.js';
      if (!existsSync(target) && existsSync(join(target, 'index.js'))) target = join(target, 'index.js');
      if (!existsSync(target)) throw new Error(`${id}: cannot resolve '${spec}'`);
      return loadModule(target);
    }
    if (spec.startsWith('node:') || spec === 'fs' || spec === 'path') {
      throw new Error(`${id}: '${spec}' is unavailable in the browser bundle`);
    }
    return spec;
  };
  const { code } = transform(src, id, resolveSpec);
  modules.set(abs, { id, code });
  return id;
}

const entryAbs = resolve(ENTRY);
const entryId = loadModule(entryAbs);

/* ------------------------------------------------------------------ *
 * emit
 * ------------------------------------------------------------------ */
const recs = [...modules.entries()].map(([abs, r]) => ({ abs, ...r }));
for (const r of recs) if (!r.code) throw new Error(`unresolved module: ${r.id}`);

let out = '';
out += `window.__ModuleLoader__.load({\n`;
out += `  id: ${JSON.stringify(PKG.name)},\n`;
out += `  factory: (require) => {\n`;
out += `    var __registry = Object.create(null);\n`;
out += `    var __cache = Object.create(null);\n`;
out += `    function __define(id, fn) { __registry[id] = fn; }\n`;
out += `    function __require(id) {\n`;
out += `      var hit = __cache[id];\n`;
out += `      if (hit) return hit.exports;\n`;
out += `      var fn = __registry[id];\n`;
out += `      if (!fn) return require(id);\n`;
out += `      var m = { exports: {} };\n`;
out += `      Object.defineProperty(m.exports, Symbol.toStringTag, { value: 'Module' });\n`;
out += `      __cache[id] = m;\n`;
out += `      fn(m, m.exports, function (s) { return __registry[s] ? __require(s) : require(s); });\n`;
out += `      return m.exports;\n`;
out += `    }\n\n`;

const ordered = recs.filter((r) => r.id !== entryId).sort((a, b) => a.id.localeCompare(b.id));
for (const r of [...ordered, recs.find((x) => x.id === entryId)]) {
  out += `    __define(${JSON.stringify(r.id)}, function (module, exports, require) {\n`;
  out += indentBlock(r.code, 6);
  out += `    });\n\n`;
}
out += `    return __require(${JSON.stringify(entryId)});\n`;
out += `  },\n});\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`bundled ${recs.length} module(s) -> ${relative(ROOT, OUT)} (${(out.length / 1024).toFixed(1)} KiB)`);
for (const r of recs) console.log(`  - ${r.id}${r.json ? ' (json)' : ''}`);

function indentBlock(code, spaces) {
  const pad = ' '.repeat(spaces);
  return code.split('\n').map((l) => (l ? pad + l : l)).join('\n').replace(/\s*$/, '') + '\n';
}
