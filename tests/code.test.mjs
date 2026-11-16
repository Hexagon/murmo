// Code in messages (docs/DESIGN.md §6.10): cutting text into inline code and blocks, and colouring blocks. The text
// is from others, so besides what it shows, this checks that nothing is lost or invented, that only the fixed token
// classes come out, and that hostile input cannot make the recipient's page slow.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as code from "../client/js/code.js";

const TEXT_MAX = 8000; // core.js

test("text without backticks is one piece, unchanged", () => {
  for (const t of ["", "hej", "a\nb\n\n c ", "2*3*4 __init__.py <b>x</b> [a](b)"]) {
    assert.deepEqual(code.parse(t), [{ type: "text", text: t }]);
  }
});

test("inline code", () => {
  assert.deepEqual(code.parse("run `npm test` now"), [
    { type: "text", text: "run " },
    { type: "code", text: "npm test" },
    { type: "text", text: " now" },
  ]);
  // Longer runs hold backticks; one space inside each side is dropped (CommonMark).
  assert.deepEqual(code.parse("`` a`b ``"), [{ type: "code", text: "a`b" }]);
  assert.deepEqual(code.parse("` `"), [{ type: "code", text: " " }]);
  // Unmatched runs stay text, and a run only closes one of the same length.
  assert.deepEqual(code.parse("it`s"), [{ type: "text", text: "it`s" }]);
  assert.deepEqual(code.parse("`a``b`"), [{ type: "code", text: "a``b" }]);
  // Inline code does not run over a line break.
  assert.deepEqual(code.parse("`a\nb`"), [{ type: "text", text: "`a\nb`" }]);
  // Three backticks with the code on one line are inline code, not a block.
  assert.deepEqual(code.parse("```x = 1```"), [{ type: "code", text: "x = 1" }]);
});

test("fenced blocks", () => {
  assert.deepEqual(code.parse("Look:\n```js\nconst a = 1;\n\nf(a);\n```\nRight?"), [
    { type: "text", text: "Look:" },
    { type: "block", lang: "javascript", label: "js", text: "const a = 1;\n\nf(a);" },
    { type: "text", text: "Right?" },
  ]);
  // No language; a longer fence; a closing run at the end of the last line; an unclosed block runs to the end.
  assert.deepEqual(code.parse("```\nx\n```"), [{ type: "block", lang: null, label: "", text: "x" }]);
  assert.deepEqual(code.parse("````md\n```\n````"), [{ type: "block", lang: null, label: "md", text: "```" }]);
  assert.deepEqual(code.parse("```py\nprint(1)```"), [{ type: "block", lang: "python", label: "py", text: "print(1)" }]);
  assert.deepEqual(code.parse("```sh\nls\n"), [{ type: "block", lang: "bash", label: "sh", text: "ls" }]);
  // Indented fences strip as much indentation from the code; blank lines around a block go.
  assert.deepEqual(code.parse("  ```\n    a\n  b\n  ```"), [{ type: "block", lang: null, label: "", text: "  a\nb" }]);
  assert.deepEqual(code.parse("a\n\n\n```\nb\n```\n\n\nc"), [
    { type: "text", text: "a" },
    { type: "block", lang: null, label: "", text: "b" },
    { type: "text", text: "c" },
  ]);
  // Backticks inside a block are code, not inline code.
  assert.deepEqual(code.parse("```\n`x`\n```"), [{ type: "block", lang: null, label: "", text: "`x`" }]);
});

test("a block's label is only a plausible language word", () => {
  const lbl = (info) => code.parse(`\`\`\`${info}\nx\n\`\`\``)[0].label;
  assert.equal(lbl("Rust"), "rust");
  assert.equal(lbl("c++ {.numberLines}"), "c++");
  assert.equal(lbl("<img src=x>"), "");
  assert.equal(lbl("a".repeat(25)), "");
  assert.equal(lbl("javascript:alert(1)"), "");
  assert.equal(code.label("cpp", "c++"), "C++");
  assert.equal(code.label(null, "brainfuck"), "brainfuck");
});

test("inFence: whether the composer's cursor is inside an open block", () => {
  assert.equal(code.inFence("hi\n```js\nfoo("), true);
  assert.equal(code.inFence("```"), true);
  assert.equal(code.inFence("```\nx\n```"), false);
  assert.equal(code.inFence("```x```"), false);
  assert.equal(code.inFence("`x"), false);
  assert.equal(code.inFence(""), false);
});

const join = (toks) => toks.map(([, s]) => s).join("");

const SAMPLES = {
  javascript: "import { a } from \"./b.js\";\nconst re = /x/g; // c\nlet t = `a ${b}\nc`;\nclass A extends B { async f() { return null ?? 0x1F; } }",
  typescript: "interface P { name: string; age?: number }\nconst x: Array<P> = [] as P[];",
  json: '{"a": [1, 2.5e3, true, null], "b" : {"c": "d\\"e"}}',
  python: 'def f(x: int) -> str:\n    """doc\n    string"""\n    return f"{x}"  # c\n@dec\nclass A(B): pass',
  rust: "fn main<'a>(s: &'a str) -> Result<(), Box<dyn Error>> {\n    let c = '\\n';\n    println!(\"{s}\");\n    1..2;\n}",
  go: "package main\nfunc main() {\n\ts := `raw\nstring`\n\tfmt.Println(s, nil)\n}",
  c: "#include <stdio.h>\nint main(void) { char c = 'x'; /* c */ return 0; }",
  cpp: "#pragma once\nstd::vector<int> v{1, 2}; auto p = nullptr;",
  java: "@Override public static void main(String[] args) { System.out.println(\"x\"); }",
  bash: "#!/bin/sh\nfor f in *.txt; do echo \"$f ${HOME}\" $# # c\ndone\napt-get install -y x",
  sql: "SELECT a, count(*) FROM t WHERE b = 'x' -- c\n/* d */ ORDER BY 1;",
  css: "@media (max-width: 9px) { .a:hover { color: #fff !important; margin: 0 1.5em; } }",
  markup: '<!DOCTYPE html>\n<a href="x" disabled>t &amp; <!-- c --></a><br/>',
  yaml: "key: value # c\n- name: \"x\"\nurl: http://a#b",
  toml: '[s]\nkey = """a\nb"""\nn = 1 # c',
  diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n z",
};

test("every language is covered by a sample", () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...code.LANGUAGES].sort());
});

test("highlighting keeps the text exactly and uses only the fixed classes", () => {
  for (const [lang, src] of Object.entries(SAMPLES)) {
    const toks = code.highlight(lang, src);
    assert.equal(join(toks), src, lang);
    assert.ok(toks.some(([c]) => c), `${lang} has some colour`);
    for (const [c, s] of toks) {
      assert.ok(c === null || code.CLASSES.has(c), `${lang}: class ${c}`);
      assert.ok(s.length > 0, `${lang}: empty token`);
    }
  }
});

test("some tokens are what they look like", () => {
  const cls = (lang, src, word) => code.highlight(lang, src).find(([, s]) => s === word)?.[0];
  assert.equal(cls("javascript", "const x = 'a' // b", "const"), "k");
  assert.equal(cls("javascript", "const x = 'a' // b", "'a'"), "s");
  assert.equal(cls("javascript", "const x = 'a' // b", "// b"), "c");
  assert.equal(cls("javascript", "f(1)", "f"), "f");
  assert.equal(cls("python", "x = None", "None"), "l");
  assert.equal(cls("rust", "let n = 10u8;", "10u8"), "n");
  assert.equal(cls("rust", "fn f<'a>()", "'a"), "l");
  assert.equal(cls("json", '{"k": "v"}', '"k"'), "a");
  assert.equal(cls("json", '{"k": "v"}', '"v"'), "s");
  assert.equal(cls("sql", "select 1", "select"), "k");
  assert.equal(cls("bash", "echo $HOME", "$HOME"), "v");
  assert.equal(cls("yaml", "url: http://a#b", "url"), "a");
  assert.equal(cls("diff", "+a\n-b", "+a"), "add");
  assert.equal(cls("markup", "<b>", "<b"), "tag");
});

test("unknown languages, and very long blocks, are not coloured", () => {
  assert.deepEqual(code.highlight(null, "const x"), [[null, "const x"]]);
  assert.deepEqual(code.highlight("nope", "const x"), [[null, "const x"]]);
  assert.deepEqual(code.highlight("javascript", ""), []);
  const big = "x ".repeat(code.HIGHLIGHT_MAX);
  assert.deepEqual(code.highlight("javascript", big), [[null, big]]);
});

/** Run `f` and fail if it takes longer than `ms` (generous: CI machines are slow; quadratic cases take seconds). */
function quick(name, f, ms = 250) {
  const t = performance.now();
  f();
  const took = performance.now() - t;
  assert.ok(took < ms, `${name} took ${took.toFixed(0)} ms`);
}

test("hostile input stays fast", () => {
  const n = TEXT_MAX;
  const inputs = {
    backticks: "`".repeat(n),
    pairs: "` ".repeat(n / 2),
    growingRuns: Array.from({ length: 120 }, (_, i) => "`".repeat(i + 1)).join(" ").slice(0, n),
    unclosedRuns: "``` a ".repeat(n / 6),
    fences: "```\n".repeat(n / 4),
    fencesWithInfo: "```js\n".repeat(n / 6),
    blankLines: "a\n```\nb\n```" + "\n".repeat(n - 12) + "c",
    closers: "```\n" + "x```\n".repeat(n / 5),
    mixedLine: "a `b` ".repeat(n / 6),
  };
  for (const [name, s] of Object.entries(inputs)) quick(`parse ${name}`, () => code.parse(s));
  for (const lang of code.LANGUAGES) {
    const hostile = {
      openComment: "/*" + "a".repeat(n),
      quotes: "\"'`".repeat(n / 3),
      escapes: '"' + "\\".repeat(n),
      lines: "#\n".repeat(n / 2),
      words: "a ".repeat(n / 2),
      keyish: "a: ".repeat(n / 3),
      tags: "<a ".repeat(n / 3),
      entities: "&a".repeat(n / 2),
      numbers: "1.".repeat(n / 2),
      dollars: "${".repeat(n / 2),
      ats: "@a".repeat(n / 2),
      dashes: "-\n+\n".repeat(n / 4),
    };
    for (const [name, s] of Object.entries(hostile)) {
      quick(`${lang} ${name}`, () => assert.equal(join(code.highlight(lang, s)), s));
    }
  }
});

test("random text: parts and tokens never lose or invent text", () => {
  const alphabet = ["`", "```", "\n", " ", "a", "js", "'", '"', "/*", "*/", "#", "<", ">", "$", "{", "}", "\\", "-", ":", "1"];
  let seed = 1;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % k);
  for (let round = 0; round < 500; round++) {
    let s = "";
    for (let i = rnd(60); i > 0; i--) s += alphabet[rnd(alphabet.length)];
    const parts = code.parse(s);
    for (const p of parts) {
      assert.ok(["text", "code", "block"].includes(p.type));
      assert.equal(typeof p.text, "string");
      if (p.type === "block") {
        assert.ok(p.lang === null || code.LANGUAGES.includes(p.lang));
        assert.match(p.label, /^[a-z0-9_+#.-]{0,24}$/);
        for (const lang of code.LANGUAGES) assert.equal(join(code.highlight(lang, p.text)), p.text);
      }
    }
    // What is shown (backticks and blanks aside) comes from the text, in order: nothing is invented or reordered.
    const keep = (x) => x.replace(/[`\s]/g, "");
    const shown = keep(parts.map((p) => (p.type === "block" ? p.label + p.text : p.text)).join(""));
    const all = keep(s);
    let at = 0;
    for (const ch of shown) at = all.indexOf(ch, at) + 1 || assert.fail(`invented ${JSON.stringify(ch)} in ${JSON.stringify(s)}`);
    if (!s.includes("`")) assert.equal(parts[0].text, s);
  }
});
