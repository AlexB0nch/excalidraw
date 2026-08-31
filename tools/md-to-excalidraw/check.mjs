/**
 * Checks for the generator. Deliberately not named `*.test.mjs`: vitest's
 * default glob would pick that up and try to run it as part of `yarn test`,
 * and these are node:test cases.
 *
 *   node --test tools/md-to-excalidraw/check.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync as readFile, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildScene, parseMarkdown } from "./index.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const BASE = "https://draw.example.com/";

const SAMPLE = `# Отчёт

Вводная строка про **цифры**.

## Первый раздел

### Подзаголовок
- пункт один
- пункт два с [ссылкой](https://example.com) и \`кодом\`

## Второй раздел

- единственный пункт
`;

const scene = () => buildScene(parseMarkdown(SAMPLE), { baseUrl: BASE });

const frameIds = (s) =>
  new Set(s.elements.filter((e) => e.type === "frame").map((e) => e.id));

test("parses headings, lead and items", () => {
  const doc = parseMarkdown(SAMPLE);
  assert.equal(doc.title, "Отчёт");
  assert.deepEqual(doc.lead, ["Вводная строка про цифры."]);
  assert.deepEqual(
    doc.sections.map((s) => s.title),
    ["Первый раздел", "Второй раздел"],
  );
  assert.deepEqual(doc.sections[0].items, [
    { text: "Подзаголовок", kind: "subheading" },
    { text: "пункт один", kind: "bullet" },
    { text: "пункт два с ссылкой и кодом", kind: "bullet" },
  ]);
});

test("skips fenced code blocks", () => {
  const doc = parseMarkdown("# T\n## S\n```\n- not a bullet\n```\n- real\n");
  assert.deepEqual(doc.sections[0].items, [{ text: "real", kind: "bullet" }]);
});

test("every element id is unique", () => {
  const ids = scene().elements.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("one frame per section, plus the overview", () => {
  const s = scene();
  assert.equal(frameIds(s).size, 3);
});

test("every link targets an existing frame on the base host", () => {
  const s = scene();
  const frames = frameIds(s);
  const links = s.elements.filter((e) => e.link);
  assert.ok(links.length >= 3, "expected overview cards and back buttons");
  for (const element of links) {
    const match = element.link.match(/^https:\/\/draw\.example\.com\/\?element=(.+)$/);
    assert.ok(match, `link not an element link: ${element.link}`);
    assert.ok(frames.has(match[1]), `link points at a non-frame: ${element.link}`);
  }
});

test("each section card links to its own frame", () => {
  const s = scene();
  const sectionFrames = s.elements.filter(
    (e) => e.type === "frame" && e.name !== "Отчёт",
  );
  const targets = s.elements
    .filter((e) => e.link)
    .map((e) => e.link.split("=")[1]);
  for (const frame of sectionFrames) {
    assert.ok(targets.includes(frame.id), `no card links to ${frame.name}`);
  }
});

test("children stay inside their frame's box", () => {
  const s = scene();
  const boxes = new Map(
    s.elements
      .filter((e) => e.type === "frame")
      .map((e) => [e.id, e]),
  );
  for (const element of s.elements) {
    if (!element.frameId) {
      continue;
    }
    const f = boxes.get(element.frameId);
    assert.ok(f, `frameId references a missing frame: ${element.frameId}`);
    assert.ok(element.x >= f.x - 1, `${element.type} overflows left`);
    assert.ok(element.y >= f.y - 1, `${element.type} overflows top`);
    assert.ok(
      element.x + element.width <= f.x + f.width + 1,
      `${element.type} overflows right`,
    );
    assert.ok(
      element.y + element.height <= f.y + f.height + 1,
      `${element.type} overflows bottom`,
    );
  }
});

test("frames do not overlap each other", () => {
  const frames = scene().elements.filter((e) => e.type === "frame");
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i];
      const b = frames[j];
      const overlaps =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      assert.ok(!overlaps, `"${a.name}" overlaps "${b.name}"`);
    }
  }
});

test("output is deterministic", () => {
  assert.deepEqual(scene(), scene());
});

test("ids survive many keys without colliding", () => {
  const many = [`# T`, ...Array.from({ length: 300 }, (_, i) => `## Раздел ${i}`)];
  const s = buildScene(parseMarkdown(many.join("\n\n")), { baseUrl: BASE });
  const ids = s.elements.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("CLI entry point runs when its own path contains a space", () => {
  // Regression test: `import.meta.url === \`file://${process.argv[1]}\`` used
  // to compare a URL-escaped string (spaces as %20) against a raw path (spaces
  // literal). The mismatch made the main() guard silently false -- exit 0, no
  // output, no file written -- whenever the script lived under a path with a
  // space. Reproduce that exact shape: copy the script into a spaced dir and
  // invoke it as a real subprocess, the only way to exercise import.meta.url.
  const dir = mkdtempSync(join(tmpdir(), "md-to-excalidraw check "));
  try {
    const script = join(dir, "index.mjs");
    const input = join(dir, "in.md");
    const output = join(dir, "out.excalidraw");
    cpSync(join(HERE, "index.mjs"), script);
    cpSync(join(HERE, "example.md"), input);

    const result = spawnSync(
      process.execPath,
      [script, input, "--base-url", BASE, "-o", output],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, `CLI exited nonzero: ${result.stderr}`);
    assert.match(
      result.stderr,
      /section frames/,
      "CLI should report what it wrote, not silently no-op",
    );
    assert.ok(existsSync(output), "CLI silently produced no output file");
    const scene = JSON.parse(readFile(output, "utf8"));
    assert.ok(scene.elements.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
