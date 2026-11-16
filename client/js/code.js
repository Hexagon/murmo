// Code in messages (docs/DESIGN.md §6.10): `inline code` and fenced blocks with syntax highlighting.
//
// This module only cuts text into pieces; it makes no DOM and no HTML. app.js turns the pieces into elements with
// `h()`, so text from others still only ever becomes text nodes, and the only classes that come out of here are the
// fixed token names in CLASSES. Nothing else of Markdown is understood: no links, images, HTML, emphasis or headings.
//
// Everything here runs on text from others, so every scan is linear in the length of the text: no regular expression
// that can backtrack over the input, no nested search that starts again from each position.

/** Blocks longer than this are shown without colours (the text is limited to 8000 characters anyway, core.js). */
export const HIGHLIGHT_MAX = 16384;

/** The token classes `highlight` can give: keyword, string, comment, number, literal, type, function, attribute or
 * key, variable, markup tag, and diff's added, removed and meta lines. app.js uses them as `tk-<name>`. */
export const CLASSES = new Set(["k", "s", "c", "n", "l", "t", "f", "a", "v", "tag", "add", "del", "meta"]);

// ── cutting a message into text, inline code and blocks ──────────────────────────────────────────────────────────

/** An opening fence: at most three spaces, then three or more backticks, then an info string without backticks. */
function opening(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  let j = i;
  while (line[j] === "`") j++;
  if (j - i < 3) return null;
  const info = line.slice(j);
  if (info.includes("`")) return null; // "```x```" on one line is inline code, as in CommonMark
  return { indent: i, len: j - i, info: info.trim() };
}

/**
 * Whether `line` closes a fence of `len` backticks. Either a line of only backticks (at least `len`, with at most
 * three spaces before and any after), or, as many chat apps allow, code that ends in such a run: `}```` closes and
 * keeps `}`. Returns the code left on the line ("" for none), or null if the line does not close.
 */
function closing(line, len) {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  let start = end;
  while (start > 0 && line[start - 1] === "`") start--;
  if (end - start < len) return null;
  const before = line.slice(0, start);
  if (/^ {0,3}$/.test(before)) return "";
  return before;
}

/** A language word from an info string: the first word, if it is a plausible name (shown as the block's label). */
function langWord(info) {
  const w = info.split(/[\s{]/, 1)[0].toLowerCase();
  return /^[a-z0-9_+#.-]{1,24}$/.test(w) ? w : "";
}

/** Lines of `text` as blocks and runs of text: `{ block: false, lines }` or `{ block: true, fence, lines, open }`. */
function chunks(text) {
  const out = [];
  let plain = [];
  let block = null;
  for (const line of text.split("\n")) {
    if (block) {
      const rest = closing(line, block.fence.len);
      if (rest === null) {
        block.lines.push(line);
        continue;
      }
      if (rest) block.lines.push(rest);
      block.open = false;
      out.push(block);
      block = null;
      continue;
    }
    const f = opening(line);
    if (f) {
      if (plain.length) out.push({ block: false, lines: plain });
      plain = [];
      block = { block: true, fence: f, lines: [], open: true };
    } else plain.push(line);
  }
  if (block) out.push(block); // an unclosed block runs to the end of the message, as in CommonMark
  else if (plain.length) out.push({ block: false, lines: plain });
  return out;
}

/** Inline code spans in one line: a run of n backticks up to the next run of exactly n. Linear in the line. */
function inline(line, parts) {
  const runs = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (line[j] === "`") j++;
    runs.push({ at: i, len: j - i });
    i = j;
  }
  // For each run, the next run of the same length (one pass from the right).
  const next = new Array(runs.length);
  const seen = new Map();
  for (let k = runs.length - 1; k >= 0; k--) {
    next[k] = seen.get(runs[k].len);
    seen.set(runs[k].len, k);
  }
  let from = 0;
  for (let k = 0; k < runs.length; ) {
    const m = next[k];
    if (m === undefined) {
      k++;
      continue;
    }
    const open = runs[k];
    const close = runs[m];
    let code = line.slice(open.at + open.len, close.at);
    if (code.length > 1 && code[0] === " " && code[code.length - 1] === " " && code.trim()) code = code.slice(1, -1);
    text(parts, line.slice(from, open.at));
    parts.push({ type: "code", text: code });
    from = close.at + close.len;
    k = m + 1;
  }
  text(parts, line.slice(from));
}

/** The index of the last line with something on it, or -1. */
function lastFilled(lines) {
  let k = lines.length - 1;
  while (k >= 0 && !lines[k].trim()) k--;
  return k;
}

/** Add text to `parts`, joined to the text before it. */
function text(parts, s) {
  if (!s) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") last.text += s;
  else parts.push({ type: "text", text: s });
}

/**
 * Cut a message into `{ type: "text", text }`, `{ type: "code", text }` (inline code) and
 * `{ type: "block", lang, label, text }`. `lang` is a language `highlight` knows, or null; `label` is the word the
 * sender wrote after the fence (only letters, digits and `_+#.-`, at most 24), or "". Blank lines next to a block
 * are dropped: the block has its own margins.
 */
export function parse(input) {
  const s = String(input ?? "");
  if (!s.includes("`")) return [{ type: "text", text: s }];
  const parts = [];
  const list = chunks(s);
  list.forEach((c, n) => {
    if (c.block) {
      const strip = c.fence.indent;
      let lines = strip ? c.lines.map((l) => l.replace(new RegExp(`^ {0,${strip}}`), "")) : c.lines;
      lines = lines.slice(0, lastFilled(lines) + 1); // e.g. an unclosed block's last Enter
      const word = langWord(c.fence.info);
      parts.push({ type: "block", lang: LANG_OF.get(word) ?? null, label: word, text: lines.join("\n") });
      return;
    }
    let from = 0;
    let to = c.lines.length;
    if (n > 0) while (from < to && !c.lines[from].trim()) from++;
    if (n < list.length - 1) to = Math.max(from, lastFilled(c.lines) + 1);
    const lines = c.lines.slice(from, to);
    lines.forEach((l, i) => {
      if (i) text(parts, "\n");
      inline(l, parts);
    });
  });
  return parts.length ? parts : [{ type: "text", text: "" }];
}

/** Whether `text` (what is before the cursor in the composer) ends inside an unclosed code block. */
export function inFence(input) {
  const list = chunks(String(input ?? ""));
  const last = list[list.length - 1];
  return Boolean(last?.block && last.open);
}

// ── languages ────────────────────────────────────────────────────────────────────────────────────────────────────

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_KW = "if else for while do switch case default break continue return goto sizeof typedef struct union enum static extern const volatile inline register restrict auto signed unsigned";
const C_TYPES = "void char short int long float double bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE";

/** The languages, by name: what their tokens look like. */
const DEFS = {
  javascript: {
    name: "JavaScript",
    kw: words("break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await get set"),
    lit: words("true false null undefined NaN Infinity"),
    types: words("Object Array String Number Boolean Symbol BigInt Map Set WeakMap WeakSet Promise Date RegExp Error JSON Math console window document globalThis"),
    line: ["//"], block: [["/*", "*/"]], str: ["'", '"'], multi: ["`"], calls: true, ident$: true,
  },
  typescript: {
    name: "TypeScript",
    kw: words("break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await get set type interface enum implements namespace declare abstract readonly private protected public keyof infer is as satisfies"),
    lit: words("true false null undefined NaN Infinity"),
    types: words("string number boolean any unknown never object symbol bigint void Object Array String Number Boolean Promise Map Set Record Partial Readonly"),
    line: ["//"], block: [["/*", "*/"]], str: ["'", '"'], multi: ["`"], calls: true, ident$: true, upper: true,
  },
  json: { name: "JSON", lit: words("true false null"), str: ['"'], keys: ":", line: ["//"], block: [["/*", "*/"]] },
  python: {
    name: "Python",
    kw: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
    lit: words("True False None self cls"),
    types: words("int float str bytes bool list dict set tuple object type range len print isinstance super Exception ValueError TypeError KeyError"),
    line: ["#"], triple: ['"""', "'''"], str: ["'", '"'], calls: true, deco: true, upper: true,
  },
  rust: {
    name: "Rust",
    kw: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
    lit: words("true false None Some Ok Err"),
    types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box"),
    line: ["//"], block: [["/*", "*/"]], str: ['"'], multiAll: true, calls: true, upper: true, rustChar: true,
  },
  go: {
    name: "Go",
    kw: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    lit: words("true false nil iota"),
    types: words("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
    line: ["//"], block: [["/*", "*/"]], str: ['"', "'"], multi: ["`"], calls: true,
  },
  c: {
    name: "C",
    kw: words(C_LIKE_KW), lit: words("NULL true false"), types: words(C_TYPES),
    line: ["//"], block: [["/*", "*/"]], str: ['"', "'"], calls: true, preproc: true,
  },
  cpp: {
    name: "C++",
    kw: words(`${C_LIKE_KW} class namespace template typename public private protected virtual override final new delete this throw try catch using operator friend explicit constexpr noexcept static_cast dynamic_cast reinterpret_cast const_cast co_await co_return co_yield`),
    lit: words("NULL nullptr true false"), types: words(`${C_TYPES} std string vector map auto`),
    line: ["//"], block: [["/*", "*/"]], str: ['"', "'"], calls: true, preproc: true, upper: true,
  },
  java: {
    name: "Java",
    kw: words("abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record yield"),
    lit: words("true false null"),
    types: words("boolean byte char short int long float double void"),
    line: ["//"], block: [["/*", "*/"]], str: ['"', "'"], calls: true, deco: true, upper: true,
  },
  bash: {
    name: "Shell",
    kw: words("if then else elif fi for while until do done case esac in function return local export readonly declare unset shift exit break continue select time"),
    types: words("echo printf cd ls cat grep sed awk find xargs test read source eval exec set trap kill mkdir rm cp mv chmod chown curl git sudo"),
    lit: words("true false"),
    line: ["#"], hashSpace: true, str: ["'"], multi: ['"'], vars: true,
  },
  sql: {
    name: "SQL",
    kw: words("select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join inner left right outer full on as group by order having limit offset union all distinct case when then else end exists in is like between returning with begin commit rollback transaction default unique check constraint if replace pragma"),
    lit: words("null true false"),
    types: words("int integer bigint smallint text varchar char blob real float double numeric decimal boolean date time timestamp serial"),
    line: ["--"], block: [["/*", "*/"]], str: ["'", '"'], ci: true, calls: true,
  },
  css: {
    name: "CSS",
    block: [["/*", "*/"]], str: ["'", '"'], css: true,
  },
  markup: { name: "HTML", markup: true },
  yaml: { name: "YAML", lit: words("true false null yes no on off ~"), line: ["#"], hashSpace: true, str: ["'", '"'], keys: ":" },
  toml: { name: "TOML", lit: words("true false"), line: ["#"], str: ["'", '"'], triple: ['"""', "'''"], keys: "=" },
  diff: { name: "Diff", diff: true },
};

/** Words after a fence → language. */
const LANG_OF = new Map(
  Object.entries({
    javascript: "javascript js jsx mjs cjs node",
    typescript: "typescript ts tsx mts cts",
    json: "json jsonc json5 webmanifest",
    python: "python py python3 py3",
    rust: "rust rs",
    go: "go golang",
    c: "c h",
    cpp: "cpp c++ cc cxx hpp hxx",
    java: "java",
    bash: "bash sh shell zsh console shellscript",
    sql: "sql sqlite postgres postgresql pgsql mysql",
    css: "css",
    markup: "html htm xml svg xhtml",
    yaml: "yaml yml",
    toml: "toml",
    diff: "diff patch",
  }).flatMap(([lang, names]) => names.split(" ").map((n) => [n, lang])),
);

/** The name to show for a block: the language's own name, or the word the sender wrote, or "". */
export function label(lang, word) {
  return lang ? DEFS[lang].name : word || "";
}

// ── highlighting ─────────────────────────────────────────────────────────────────────────────────────────────────

const isDigit = (c) => c >= "0" && c <= "9";
const isIdStart = (c) => /[\p{L}_]/u.test(c);
const isId = (c) => /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Tokens out: `[class or null, text]`, with neighbouring plain text joined. */
class Out {
  constructor() {
    this.list = [];
  }
  push(cls, s) {
    if (!s) return;
    const last = this.list[this.list.length - 1];
    if (last && last[0] === cls && cls === null) last[1] += s;
    else this.list.push([cls, s]);
  }
}

/** The end of a quoted string that starts at `i` (after the quote `q`), honouring backslashes. */
function stringEnd(s, i, q, multiline) {
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") j += 2;
    else if (c === q) return j + 1;
    else if (c === "\n" && !multiline) return j; // an unclosed one-line string stops at the end of its line
    else j++;
  }
  return s.length;
}

/** The index after the first of `close` from `i`, or the end of the text. */
function past(s, i, close) {
  const k = s.indexOf(close, i);
  return k < 0 ? s.length : k + close.length;
}

function lineEnd(s, i) {
  const k = s.indexOf("\n", i);
  return k < 0 ? s.length : k;
}

/** The next character that is not a space or tab, from `i`. */
function nextNonBlank(s, i) {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return s[i];
}

function code(d, s) {
  const out = new Out();
  let depth = 0; // CSS: inside braces
  let lead = true; // only blanks so far on this line (and "-" for YAML lists)
  let i = 0;
  /** Push `s[i..j]` as `cls` and go on after it. */
  const emit = (cls, j) => {
    out.push(cls, s.slice(i, j));
    i = j;
    lead = false;
  };
  while (i < s.length) {
    const c = s[i];
    const prev = s[i - 1];
    const startsWith = (x) => s.startsWith(x, i);
    let m;
    // Comments
    if ((m = d.block?.find(([o]) => startsWith(o)))) {
      emit("c", past(s, i + m[0].length, m[1]));
      continue;
    }
    if (d.line?.some((x) => startsWith(x)) && (!d.hashSpace || i === 0 || isSpace(prev))) {
      emit("c", lineEnd(s, i));
      continue;
    }
    // Preprocessor directives (C, C++): `#include`, first on a line.
    if (d.preproc && c === "#" && lead) {
      let j = i + 1;
      while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
      while (j < s.length && isId(s[j])) j++;
      emit("k", j);
      continue;
    }
    // Strings
    if ((m = d.triple?.find((x) => startsWith(x)))) {
      emit("s", past(s, i + 3, m));
      continue;
    }
    if (d.rustChar && c === "'") {
      // 'a' and '\n' are characters; 'a without a closing quote is a lifetime.
      if (s[i + 1] === "\\" || (s[i + 2] === "'" && s[i + 1] !== "'")) emit("s", stringEnd(s, i + 1, "'", false));
      else {
        let j = i + 1;
        while (j < s.length && isId(s[j])) j++;
        emit("l", j);
      }
      continue;
    }
    if (d.str?.includes(c) || d.multi?.includes(c)) {
      const j = stringEnd(s, i + 1, c, d.multiAll || d.multi?.includes(c));
      emit(d.keys && nextNonBlank(s, j) === d.keys ? "a" : "s", j);
      continue;
    }
    // Shell variables: $NAME, ${…}, $1, $?
    if (d.vars && c === "$") {
      let j = i + 1;
      if (s[j] === "{") j = past(s, j, "}");
      else if (j < s.length && isId(s[j])) while (j < s.length && isId(s[j])) j++;
      else if (j < s.length && "?#@*!$-0123456789".includes(s[j])) j++;
      if (j > i + 1) {
        emit("v", j);
        continue;
      }
    }
    // Decorators and annotations (@name), CSS at-rules (@media)
    if ((d.deco || d.css) && c === "@" && i + 1 < s.length && isIdStart(s[i + 1])) {
      let j = i + 1;
      while (j < s.length && (isId(s[j]) || s[j] === "." || s[j] === "-")) j++;
      emit(d.css ? "k" : "a", j);
      continue;
    }
    // Numbers, with their suffixes and units (0x1F, 1e9, 10px, 1_000u32)
    if ((isDigit(c) || (c === "." && isDigit(s[i + 1] ?? ""))) && !(prev && isId(prev))) {
      let j = i + 1;
      while (j < s.length && (isId(s[j]) || s[j] === ".") && !(s[j] === "." && s[j + 1] === ".")) j++;
      emit("n", j);
      continue;
    }
    // CSS colours (#fff) inside a rule
    if (d.css && c === "#" && depth > 0) {
      let j = i + 1;
      while (j < s.length && isId(s[j])) j++;
      emit("n", j);
      continue;
    }
    if (d.css && c === "!" && s.startsWith("important", i + 1)) {
      emit("k", i + 10);
      continue;
    }
    // Words
    if (isIdStart(c) || (d.ident$ && c === "$")) {
      const dash = d.css || d.vars || d.keys;
      let j = i + 1;
      while (j < s.length && (isId(s[j]) || (d.ident$ && s[j] === "$") || (dash && s[j] === "-"))) j++;
      const w = s.slice(i, j);
      const lw = d.ci ? w.toLowerCase() : w;
      const after = nextNonBlank(s, j);
      let cls = null;
      if (d.css) cls = depth > 0 ? (after === ":" ? "a" : null) : "tag";
      else if (d.keys && lead && after === d.keys) cls = "a";
      else if (d.kw?.has(lw)) cls = "k";
      else if (d.lit?.has(lw)) cls = "l";
      else if (d.types?.has(lw)) cls = "t";
      else if (d.calls && (after === "(" || (d.rustChar && s[j] === "!"))) cls = "f";
      else if (d.upper && c >= "A" && c <= "Z") cls = "t";
      emit(cls, j);
      continue;
    }
    if (d.css && c === "{") depth++;
    if (d.css && c === "}") depth = Math.max(0, depth - 1);
    if (c === "\n") lead = true;
    else if (!(c === " " || c === "\t" || c === "\r" || (d.keys && c === "-"))) lead = false;
    out.push(null, c);
    i++;
  }
  return out.list;
}

/** HTML and XML: comments, tags, attribute names and values, entities. Script and style contents stay plain. */
function markup(s) {
  const out = new Out();
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (s.startsWith("<!--", i)) {
      const j = past(s, i + 4, "-->");
      out.push("c", s.slice(i, j));
      i = j;
      continue;
    }
    if (c === "<" && /[A-Za-z/!?]/.test(s[i + 1] ?? "")) {
      let j = i + 1;
      if (s[j] === "/" || s[j] === "!" || s[j] === "?") j++;
      while (j < s.length && /[\w:.-]/.test(s[j])) j++;
      out.push("tag", s.slice(i, j));
      i = j;
      // Inside the tag: attributes until `>`.
      while (i < s.length && s[i] !== ">" && s[i] !== "<") {
        const d = s[i];
        if (d === '"' || d === "'") {
          const k = past(s, i + 1, d);
          out.push("s", s.slice(i, k));
          i = k;
        } else if (/[\w:@.-]/.test(d)) {
          let k = i + 1;
          while (k < s.length && /[\w:@.-]/.test(s[k])) k++;
          out.push("a", s.slice(i, k));
          i = k;
        } else {
          out.push(null, d);
          i++;
        }
      }
      if (s[i] === ">") {
        out.push("tag", ">");
        i++;
      }
      continue;
    }
    if (c === "&") {
      let j = i + 1;
      while (j < s.length && j - i < 12 && /[\w#]/.test(s[j])) j++;
      if (s[j] === ";" && j > i + 1) {
        out.push("l", s.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    out.push(null, c);
    i++;
  }
  return out.list;
}

/** Unified diffs, line by line. */
function diff(s) {
  const out = new Out();
  let i = 0;
  while (i < s.length) {
    const j = lineEnd(s, i);
    const line = s.slice(i, j);
    let cls = null;
    if (/^(\+\+\+|---|@@|diff |index )/.test(line)) cls = "meta";
    else if (line[0] === "+") cls = "add";
    else if (line[0] === "-") cls = "del";
    out.push(cls, line);
    if (j < s.length) out.push(null, "\n");
    i = j + 1;
  }
  return out.list;
}

/**
 * Colour `src` as `lang` (a value of `parse`'s `lang`): a list of `[class, text]` where class is one of CLASSES or
 * null. Joined, the texts are exactly `src`. Unknown languages, and blocks over HIGHLIGHT_MAX, come back as one
 * plain piece: the language is never guessed.
 */
export function highlight(lang, src) {
  const s = String(src ?? "");
  const d = lang ? DEFS[lang] : null;
  if (!d || !s || s.length > HIGHLIGHT_MAX) return s ? [[null, s]] : [];
  if (d.markup) return markup(s);
  if (d.diff) return diff(s);
  return code(d, s);
}

/** The languages with colours, by their canonical name (for the docs and tests). */
export const LANGUAGES = Object.keys(DEFS);
