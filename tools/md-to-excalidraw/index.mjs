#!/usr/bin/env node
/**
 * Turns a markdown document into a navigable .excalidraw scene:
 * an overview frame with one clickable card per section, and one frame per
 * section that links back. Clicking a card zooms the viewport to its frame.
 *
 *   node tools/md-to-excalidraw/index.mjs report.md \
 *     --base-url https://draw.example.com -o report.excalidraw
 *
 * See README.md in this directory for the accepted markdown shape.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- element defaults, mirrored from packages/common/src/constants.ts --------

/** Closest built-in Excalidraw font to the brand's Inter/Manrope pairing.
 * Excalidraw ships 7 fixed font families and none of them are Inter or
 * Manrope -- Helvetica is the plain-sans fallback, not a substitute for
 * either. There is no separate bold variant to reach for headings either. */
const FONT_HELVETICA = 1;

/** Alex Shein design system: hairline flat shapes, no per-topic color coding.
 * https://github.com/AlexB0nch/excalidraw/pull/6 has the fuller writeup. */
const COLOR = {
  graphite: "#1F2328", // primary text, arrows, emphasis headings
  secondaryText: "#4B5157", // captions: lead paragraph, "back to overview"
  stone: "#8A8578", // hairline borders on every card and frame
  terracotta: "#7A3B2E", // one accent per scene, never a fill
};

/** Helvetica is proportional; this is a deliberately generous average so that
 * generated boxes never clip their label. Nothing re-measures text on import,
 * and this ratio was tuned against Excalifont, not re-validated for Helvetica. */
const CHAR_WIDTH_RATIO = 0.55;
const LINE_HEIGHT = 1.25;

// --- layout ------------------------------------------------------------------

const L = {
  frameWidth: 1000,
  frameGap: 160,
  framesPerRow: 3,
  padding: 48,
  cardWidth: 340,
  cardHeight: 96,
  cardGapY: 40,
  centerWidth: 380,
  centerHeight: 140,
  columnGap: 120,
  bulletFontSize: 18,
  headingFontSize: 32,
  cardFontSize: 20,
  leadFontSize: 16,
};

// --- deterministic ids and seeds ---------------------------------------------

/** FNV-1a. Only used for element seeds and nonces, where collisions are
 * cosmetic (they just make two shapes wobble identically). */
const hash = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

const ID_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

/**
 * Ids must be stable across runs -- every `?element=` link is an id, so a
 * regenerated scene has to reuse them -- and they must not collide, because a
 * duplicate id silently corrupts the scene. Hence a real digest rather than a
 * hand-rolled PRNG: 21 characters of 6 bits each is 126 bits of id.
 */
const makeId = (key) => {
  const digest = createHash("sha256").update(key).digest();
  let out = "";
  for (let i = 0; i < 21; i++) {
    out += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  }
  return out;
};

const seedFor = (key) => hash(`seed:${key}`) % 2147483647;

// --- markdown parsing --------------------------------------------------------

/**
 * `# heading` opens the document, everything before the first `##` is the lead,
 * and each `##` becomes one section (one frame). Inside a section, `###` lines
 * become sub-headings and `-`/`*`/`1.` lines and plain paragraphs become
 * bullets. Everything else (code fences, tables, images) is skipped.
 */
export const parseMarkdown = (source) => {
  const lines = source.split(/\r?\n/);
  const doc = { title: null, lead: [], sections: [] };
  let section = null;
  let inFence = false;

  const push = (text, kind) => {
    const value = inlineToText(text);
    if (!value) {
      return;
    }
    if (section) {
      section.items.push({ text: value, kind });
    } else if (doc.title) {
      doc.lead.push(value);
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || /^([-*_]\s*){3,}$/.test(line) || line === "⁂") {
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = inlineToText(heading[2]);
      if (level === 1 && !doc.title) {
        doc.title = text;
      } else if (level <= 2) {
        section = { title: text, items: [] };
        doc.sections.push(section);
      } else {
        push(text, "subheading");
      }
      continue;
    }

    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    push(bullet ? bullet[1] : line, bullet ? "bullet" : "paragraph");
  }

  if (!doc.title) {
    doc.title = "Схема";
  }
  return doc;
};

/** Strips the inline markup that would otherwise show up as literal characters
 * on the canvas. Link text is kept, the target dropped. */
const inlineToText = (text) =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\[\d+\]/g, "")
    .trim();

// --- text helpers ------------------------------------------------------------

const wrap = (text, maxChars) => {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= maxChars) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.length ? lines : [""];
};

const textWidth = (lines, fontSize) =>
  Math.ceil(
    Math.max(...lines.map((l) => l.length)) * fontSize * CHAR_WIDTH_RATIO,
  );

const textHeight = (lines, fontSize) =>
  Math.ceil(lines.length * fontSize * LINE_HEIGHT);

// --- element factories -------------------------------------------------------

const base = (key, props) => ({
  id: makeId(key),
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  angle: 0,
  strokeColor: COLOR.graphite,
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: seedFor(key),
  version: 1,
  versionNonce: seedFor(`nonce:${key}`),
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...props,
});

const frame = (key, { x, y, width, height, name }) =>
  base(key, { type: "frame", x, y, width, height, name });

const rect = (key, { x, y, width, height, frameId, bg, stroke, link }) =>
  base(key, {
    type: "rectangle",
    x,
    y,
    width,
    height,
    frameId,
    backgroundColor: bg ?? "transparent",
    strokeColor: stroke ?? COLOR.stone,
    // Square corners: the design system is radius 0 throughout, unlike
    // Excalidraw's own default adaptive rounding on rectangles.
    roundness: null,
    link: link ?? null,
  });

const text = (
  key,
  { x, y, lines, fontSize, frameId, color, align = "left" },
) => {
  const value = lines.join("\n");
  return base(key, {
    type: "text",
    x,
    y,
    width: textWidth(lines, fontSize),
    height: textHeight(lines, fontSize),
    frameId,
    strokeColor: color ?? COLOR.graphite,
    text: value,
    originalText: value,
    fontSize,
    fontFamily: FONT_HELVETICA,
    textAlign: align,
    verticalAlign: "top",
    containerId: null,
    lineHeight: LINE_HEIGHT,
    autoResize: true,
  });
};

const arrow = (key, { x, y, dx, dy, frameId, color }) =>
  base(key, {
    type: "arrow",
    x,
    y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    frameId,
    strokeColor: color ?? COLOR.graphite,
    points: [
      [0, 0],
      [dx, dy],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
    roundness: null,
  });

// --- scene construction ------------------------------------------------------

export const buildScene = (doc, { baseUrl }) => {
  const elements = [];
  const linkTo = (id) => `${baseUrl}?element=${id}`;

  const sections = doc.sections;
  const overviewId = makeId("frame:overview");

  // -- section frames, laid out on a grid below the overview -----------------
  const sectionLayouts = sections.map((section, i) => {
    const cardLines = wrap(section.title, 26);
    const body = section.items.flatMap((item) => {
      const prefix = item.kind === "subheading" ? "" : "•  ";
      const indent = item.kind === "subheading" ? "" : "    ";
      const chunks = wrap(item.text, 52);
      return chunks.map((line, idx) => ({
        text: (idx === 0 ? prefix : indent) + line,
        kind: item.kind,
      }));
    });
    return { section, index: i, cardLines, body };
  });

  const bodyHeight = (body) =>
    Math.max(
      1,
      body.reduce(
        (acc, line) =>
          acc + (line.kind === "subheading" ? 1.6 : 1) * L.bulletFontSize * 1.6,
        0,
      ),
    );

  const rowHeights = [];
  sectionLayouts.forEach((layout, i) => {
    const row = Math.floor(i / L.framesPerRow);
    const height =
      L.padding * 2 + L.headingFontSize * 2.2 + bodyHeight(layout.body) + 120;
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, Math.ceil(height));
  });

  // -- overview frame ---------------------------------------------------------
  const leftCount = Math.ceil(sections.length / 2);
  const columnRows = Math.max(leftCount, sections.length - leftCount, 1);
  const overviewHeight = Math.max(
    L.padding * 2 + 200 + columnRows * (L.cardHeight + L.cardGapY),
    L.centerHeight + 400,
  );
  const overviewWidth =
    L.cardWidth * 2 + L.centerWidth + L.columnGap * 2 + L.padding * 2;

  elements.push(
    frame("frame:overview", {
      x: 0,
      y: 0,
      width: overviewWidth,
      height: overviewHeight,
      name: doc.title,
    }),
  );

  const titleLines = wrap(doc.title, 46);
  elements.push(
    text("overview:title", {
      x: L.padding,
      y: L.padding,
      lines: titleLines,
      fontSize: L.headingFontSize,
      frameId: overviewId,
    }),
  );

  let cursorY = L.padding + textHeight(titleLines, L.headingFontSize) + 16;
  if (doc.lead.length) {
    const leadLines = doc.lead.flatMap((line) => wrap(line, 90)).slice(0, 6);
    elements.push(
      text("overview:lead", {
        x: L.padding,
        y: cursorY,
        lines: leadLines,
        fontSize: L.leadFontSize,
        frameId: overviewId,
        color: COLOR.secondaryText,
      }),
    );
    cursorY += textHeight(leadLines, L.leadFontSize) + 24;
  }

  const columnTop = cursorY + 24;
  const centerX = L.padding + L.cardWidth + L.columnGap;
  const centerY =
    columnTop +
    Math.max(0, (columnRows * (L.cardHeight + L.cardGapY) - L.centerHeight) / 2);

  elements.push(
    rect("overview:center", {
      x: centerX,
      y: centerY,
      width: L.centerWidth,
      height: L.centerHeight,
      frameId: overviewId,
      stroke: COLOR.stone,
    }),
  );
  // The one terracotta touch in the whole scene: a 3px accent strip on the
  // hub card, filled rather than a hairline -- everything else stays stone
  // or graphite. Which single element earns the accent is content-dependent
  // (the brand spec picks a different node per document); the hub is the one
  // structurally unambiguous choice a generic layout can make on its own.
  elements.push(
    rect("overview:centerAccent", {
      x: centerX,
      y: centerY,
      width: L.centerWidth,
      height: 3,
      frameId: overviewId,
      bg: COLOR.terracotta,
      stroke: COLOR.terracotta,
    }),
  );
  const centerLines = wrap(doc.title, 24);
  elements.push(
    text("overview:centerLabel", {
      x: centerX + 24,
      y: centerY + (L.centerHeight - textHeight(centerLines, 22)) / 2,
      lines: centerLines,
      fontSize: 22,
      frameId: overviewId,
    }),
  );

  sectionLayouts.forEach((layout, i) => {
    const isLeft = i < leftCount;
    const row = isLeft ? i : i - leftCount;
    const x = isLeft
      ? L.padding
      : L.padding + L.cardWidth + L.columnGap + L.centerWidth + L.columnGap;
    const y = columnTop + row * (L.cardHeight + L.cardGapY);
    const targetFrameId = makeId(`frame:section:${i}`);

    elements.push(
      rect(`overview:card:${i}`, {
        x,
        y,
        width: L.cardWidth,
        height: L.cardHeight,
        frameId: overviewId,
        link: linkTo(targetFrameId),
      }),
    );
    elements.push(
      text(`overview:cardLabel:${i}`, {
        x: x + 20,
        y:
          y +
          (L.cardHeight - textHeight(layout.cardLines, L.cardFontSize)) / 2,
        lines: layout.cardLines,
        fontSize: L.cardFontSize,
        frameId: overviewId,
      }),
    );

    const fromX = isLeft ? centerX : centerX + L.centerWidth;
    const toX = isLeft ? x + L.cardWidth : x;
    elements.push(
      arrow(`overview:arrow:${i}`, {
        x: fromX,
        y: centerY + L.centerHeight / 2,
        dx: toX - fromX,
        dy: y + L.cardHeight / 2 - (centerY + L.centerHeight / 2),
        frameId: overviewId,
      }),
    );
  });

  // -- one frame per section --------------------------------------------------
  const gridTop = overviewHeight + L.frameGap * 1.5;
  sectionLayouts.forEach((layout, i) => {
    const row = Math.floor(i / L.framesPerRow);
    const col = i % L.framesPerRow;
    const x = col * (L.frameWidth + L.frameGap);
    const y =
      gridTop +
      rowHeights
        .slice(0, row)
        .reduce((acc, h) => acc + h + L.frameGap, 0);
    const height = rowHeights[row];
    const frameId = makeId(`frame:section:${i}`);

    elements.push(
      frame(`frame:section:${i}`, {
        x,
        y,
        width: L.frameWidth,
        height,
        name: layout.section.title,
      }),
    );

    const headingLines = wrap(layout.section.title, 34);
    elements.push(
      text(`section:${i}:heading`, {
        x: x + L.padding,
        y: y + L.padding,
        lines: headingLines,
        fontSize: L.headingFontSize,
        frameId,
      }),
    );

    let lineY =
      y + L.padding + textHeight(headingLines, L.headingFontSize) + 28;
    layout.body.forEach((line, idx) => {
      const fontSize =
        line.kind === "subheading" ? L.bulletFontSize + 4 : L.bulletFontSize;
      elements.push(
        text(`section:${i}:line:${idx}`, {
          x: x + L.padding,
          y: lineY,
          lines: [line.text],
          fontSize,
          frameId,
        }),
      );
      lineY += fontSize * 1.6;
    });

    elements.push(
      rect(`section:${i}:back`, {
        x: x + L.padding,
        y: y + height - L.padding - 56,
        width: 240,
        height: 56,
        frameId,
        link: linkTo(overviewId),
      }),
    );
    elements.push(
      text(`section:${i}:backLabel`, {
        x: x + L.padding + 20,
        y: y + height - L.padding - 56 + 16,
        lines: ["←  К обзору"],
        fontSize: 18,
        frameId,
        color: COLOR.secondaryText,
      }),
    );
  });

  // Duplicate ids corrupt a scene quietly: elements disappear and element
  // links resolve to the wrong frame. Cheaper to crash here.
  const seen = new Set();
  for (const element of elements) {
    if (seen.has(element.id)) {
      throw new Error(`duplicate element id generated: ${element.id}`);
    }
    seen.add(element.id);
  }

  return {
    type: "excalidraw",
    version: 2,
    source: baseUrl,
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
  };
};

// --- cli ---------------------------------------------------------------------

const parseArgs = (argv) => {
  const args = { input: null, output: null, baseUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") {
      args.output = argv[++i];
    } else if (arg === "--base-url") {
      args.baseUrl = argv[++i];
    } else if (!arg.startsWith("-")) {
      args.input = arg;
    }
  }
  return args;
};

const normalizeBaseUrl = (url) => {
  const trimmed = url.replace(/\?.*$/, "").replace(/#.*$/, "");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input || !args.baseUrl) {
    console.error(
      "usage: node tools/md-to-excalidraw/index.mjs <input.md> " +
        "--base-url <https://your-excalidraw-host/> [-o <output.excalidraw>]\n\n" +
        "--base-url must be the host you open the scene on -- Excalidraw only\n" +
        "treats a link as an in-scene jump when its host matches the page's.",
    );
    process.exit(1);
  }

  const doc = parseMarkdown(readFileSync(args.input, "utf8"));
  if (!doc.sections.length) {
    console.error(
      `${args.input}: no '## ' sections found, nothing to lay out as frames`,
    );
    process.exit(1);
  }

  const scene = buildScene(doc, { baseUrl: normalizeBaseUrl(args.baseUrl) });
  const json = `${JSON.stringify(scene, null, 2)}\n`;
  const output = args.output ?? args.input.replace(/\.md$/, "") + ".excalidraw";

  writeFileSync(output, json);
  console.error(
    `${output}: ${doc.sections.length} section frames, ` +
      `${scene.elements.length} elements`,
  );
};

// A plain `import.meta.url === file://${process.argv[1]}` comparison breaks
// silently (exit 0, no output, main() never runs) whenever the script's path
// contains characters a URL escapes -- a space becomes %20 in import.meta.url
// but stays a literal space in argv[1]. realpathSync compares actual paths
// instead and also collapses any symlink on either side.
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main();
}
