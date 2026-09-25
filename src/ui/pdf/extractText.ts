import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import type { Matrix, TextSegment, TextSpec } from "../../shared/types";
import { mul } from "./geometry";
import type { BulletCandidate, GlyphRun } from "./walkOps";

export interface FontInfo {
  name: string;
  /** Measured weight (100–900) when the name can't be trusted, e.g. Type3 fonts. */
  weight?: number;
  bold: boolean;
  italic: boolean;
  ascent: number;
  descent: number;
}

export type TextMode = "lines" | "keepBreaks" | "flow";
type ListType = "UNORDERED" | "ORDERED";

interface Piece {
  text: string;
  x: number; // baseline origin, page space
  y: number;
  angle: number; // radians
  fontSize: number;
  width: number;
  fontKey: string;
  run: GlyphRun | null;
  eol: boolean;
}

interface Line {
  x: number;
  y: number;
  angle: number;
  cos: number;
  sin: number;
  fontSize: number; // dominant (first) size
  start: number; // extent along baseline relative to origin
  end: number;
  segments: TextSegment[];
  fontKey: string;
  pieces: number;
  singleChars: number;
  gaps: number[];
  list: ListType | null;
  /** Offset along the baseline from the text origin to the bullet's left edge (negative). */
  bulletU: number;
}

interface Para {
  lines: Line[];
  gaps: number[];
  list: ListType | null;
}

/** A list marker (bullet glyph, number or vector dot) waiting to be matched to the line on its right. */
interface Marker {
  x: number; // glyphs: baseline origin; vectors: shape centre
  y: number;
  angle: number | null; // null for vector shapes
  type: ListType;
  /** Distance from the reference point to the marker's left edge along the baseline. */
  halfWidth: number;
  vector: BulletCandidate | null;
  piece: Piece | null;
  /** Index in `lines` where an unmatched glyph is put back as plain text. */
  insertAt: number;
}

const isSpace = (s: string) => /^\s*$/.test(s);
// Includes the private-use bullets Word emits for Symbol / Wingdings fonts.
const BULLET_CHARS = "\u2022\u25e6\u25aa\u25ab\u25cf\u25cb\u25a0\u25a1\u2023\u2043\u2219\u27a2\u25ba\u25b8\u25c6\u2756\u2713\uf0b7\uf0a7\uf076\uf0d8\uf0fc\uf0a8";
const BULLET_GLYPH = new RegExp(`^[${BULLET_CHARS}\\u00b7\\u2013\\u2014\\u2192*-]$`);
const ORDERED_GLYPH = /^(?:(?:\d{1,3}|[a-zA-Z]|[ivxlc]{1,5})[.)]|\((?:\d{1,3}|[a-zA-Z]|[ivxlc]{1,5})\))$/;
// Markers sharing a text item with their item's text ("\u2022 Text", "2. Step"). Dashes are left out: too common in prose.
const INLINE_BULLET = new RegExp(`^[${BULLET_CHARS}]\\s*(?=\\S)`);
const INLINE_ORDERED = /^(?:(?:\d{1,2}|[a-z])[.)]|\((?:\d{1,2}|[a-z])\))\s+(?=\S)/;
/** Word's second-level bullet is a Courier "o". */
const LETTER_O_FONT = /courier|symbol|wingding/i;
const norm = (s: string) => s.normalize("NFKC");

/**
 * Assigns each text item the colour of the drawing op that produced it.
 * Items and draw ops come in the same order, so we walk a glyph cursor
 * through the runs; a short lookahead resynchronises after mismatches
 * (ligatures, merged glyphs, etc.).
 */
function makeColorAssigner(runs: GlyphRun[]) {
  const chars: string[] = [];
  const owner: GlyphRun[] = [];
  for (const run of runs) {
    for (const ch of norm(run.text)) {
      if (isSpace(ch)) continue;
      chars.push(ch);
      owner.push(run);
    }
  }
  let cursor = 0;
  return (str: string): GlyphRun | null => {
    const want = [...norm(str)].filter((c) => !isSpace(c));
    if (!want.length) return null;
    if (chars[cursor] !== want[0]) {
      for (let j = cursor; j < Math.min(chars.length, cursor + 80); j++) {
        if (chars[j] === want[0] && (want.length < 2 || chars[j + 1] === want[1])) {
          cursor = j;
          break;
        }
      }
    }
    const first = owner[cursor] ?? owner[owner.length - 1] ?? null;
    cursor += want.length;
    return first;
  };
}

export function extractTexts(
  textContent: TextContent,
  viewportTransform: Matrix,
  fonts: Map<string, FontInfo>,
  runs: GlyphRun[],
  mode: TextMode,
  bullets: BulletCandidate[] = [],
): TextSpec[] {
  const scale = Math.hypot(viewportTransform[0], viewportTransform[1]);
  const colorOf = makeColorAssigner(runs);

  // 1. Items → positioned pieces
  const pieces: Piece[] = [];
  let pendingSpace = false;
  for (const raw of textContent.items) {
    const item = raw as TextItem;
    if (!("str" in item)) continue;
    if (isSpace(item.str)) {
      if (item.str.length) pendingSpace = true;
      if (item.hasEOL && pieces.length) pieces[pieces.length - 1].eol = true;
      continue;
    }
    const m = mul(viewportTransform, item.transform as Matrix);
    const fontSize = Math.hypot(m[2], m[3]);
    if (fontSize < 0.05) continue;
    const run = colorOf(item.str);
    if (run && !run.visible) continue; // OCR / invisible text layers
    pieces.push({
      text: (pendingSpace ? " " : "") + item.str,
      x: m[4],
      y: m[5],
      angle: Math.atan2(m[1], m[0]),
      fontSize,
      width: item.width * scale,
      fontKey: item.fontName,
      run,
      eol: item.hasEOL,
    });
    pendingSpace = false;
  }

  // 2. Pieces → lines
  const lines: Line[] = [];
  const markers: Marker[] = [];
  let line: Line | null = null;
  let prevEol = false;
  const markerType = (t: string, fontKey: string): ListType | null => {
    if (BULLET_GLYPH.test(t)) return "UNORDERED";
    if (t === "o" && LETTER_O_FONT.test(fonts.get(fontKey)?.name ?? fontKey)) return "UNORDERED";
    if (ORDERED_GLYPH.test(t)) return "ORDERED";
    return null;
  };
  const newLine = (p: Piece): Line => ({
    x: p.x,
    y: p.y,
    angle: p.angle,
    cos: Math.cos(p.angle),
    sin: Math.sin(p.angle),
    fontSize: p.fontSize,
    start: 0,
    end: p.width,
    segments: [segFor(p, p.text.replace(/^\s+/, ""))],
    fontKey: p.fontKey,
    pieces: 1,
    singleChars: p.text.trim().length === 1 ? 1 : 0,
    gaps: [],
    list: null,
    bulletU: 0,
  });
  /** Splits "• Text" / "2. Step" into a list line whose origin is the text start. */
  const splitInline = (p: Piece): Line | null => {
    const text = p.text.replace(/^\s+/, "");
    const bullet = text.match(INLINE_BULLET);
    const m = bullet ?? text.match(INLINE_ORDERED);
    if (!m) return null;
    const off = (p.width * (p.text.length - text.length + m[0].length)) / p.text.length;
    const l = newLine({
      ...p,
      text: text.slice(m[0].length),
      x: p.x + off * Math.cos(p.angle),
      y: p.y + off * Math.sin(p.angle),
      width: p.width - off,
    });
    l.list = bullet ? "UNORDERED" : "ORDERED";
    l.bulletU = -off;
    return l;
  };
  const segFor = (p: Piece, text: string): TextSegment => {
    const f = fonts.get(p.fontKey);
    return {
      text,
      fontName: f?.name ?? p.fontKey,
      ...(f?.weight !== undefined ? { weight: f.weight } : {}),
      bold: f?.bold ?? false,
      italic: f?.italic ?? false,
      fontSize: p.fontSize,
      color: p.run?.color ?? { r: 0, g: 0, b: 0 },
      opacity: p.run?.opacity ?? 1,
    };
  };
  for (const p of pieces) {
    let joined = false;
    if (line && !prevEol) {
      const dx = p.x - line.x;
      const dy = p.y - line.y;
      const u = dx * line.cos + dy * line.sin;
      const v = -dx * line.sin + dy * line.cos;
      const fs = Math.max(line.fontSize, p.fontSize);
      const sameAngle = Math.abs(p.angle - line.angle) < 0.01;
      if (sameAngle && Math.abs(v) < 0.35 * fs && u >= line.end - 0.6 * fs && u <= line.end + 1.2 * fs) {
        const gap = u - line.end;
        const last = line.segments[line.segments.length - 1];
        let text = p.text;
        if (gap > 0.2 * fs && !/\s$/.test(last.text) && !/^\s/.test(text)) text = " " + text;
        line.pieces++;
        if (p.text.trim().length === 1) line.singleChars++;
        if (!/\s/.test(text) && gap > -0.05 * fs) line.gaps.push(gap);
        const seg = segFor(p, text);
        if (last.fontName === seg.fontName && Math.abs(last.fontSize - seg.fontSize) < 0.01 && sameColor(last, seg)) {
          last.text += text;
        } else {
          line.segments.push(seg);
        }
        line.end = Math.max(line.end, u + p.width);
        joined = true;
      }
    }
    if (!joined) {
      // A lone bullet / number glyph starting a line is a list marker. It is matched to its
      // line geometrically below, because many PDFs draw bullets after (or long before) the text.
      const type = markerType(p.text.trim(), p.fontKey);
      if (type) {
        markers.push({ x: p.x, y: p.y, angle: p.angle, type, halfWidth: 0, vector: null, piece: p, insertAt: lines.length });
        prevEol = p.eol;
        continue;
      }
      line = splitInline(p) ?? newLine(p);
      lines.push(line);
    }
    prevEol = p.eol;
  }

  // 2b. Claim markers: glyphs and vector dots sitting just left of a line. Closest pairs win.
  for (const b of bullets) {
    if (b.used) continue;
    const r = Math.max(b.width, b.height) / 2;
    markers.push({ x: b.cx, y: b.cy, angle: null, type: "UNORDERED", halfWidth: r, vector: b, piece: null, insertAt: -1 });
  }
  const pairs: { m: Marker; l: Line; u: number; score: number }[] = [];
  for (const m of markers) {
    for (const l of lines) {
      if (l.list) continue;
      const dx = m.x - l.x;
      const dy = m.y - l.y;
      const u = dx * l.cos + dy * l.sin;
      const v = -dx * l.sin + dy * l.cos;
      const fs = l.fontSize;
      if (m.vector) {
        if (u < -0.15 * fs && u > -3.5 * fs && v < 0.15 * fs && v > -0.85 * fs) {
          pairs.push({ m, l, u: u - m.halfWidth, score: Math.abs(v + 0.35 * fs) / fs + (0.1 * -u) / fs });
        }
      } else if (Math.abs(m.angle! - l.angle) < 0.01 && Math.abs(v) < 0.4 * fs && u < -0.1 * fs && u > -4 * fs) {
        pairs.push({ m, l, u, score: Math.abs(v) / fs + (0.1 * -u) / fs });
      }
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  const claimed = new Set<Marker>();
  for (const { m, l, u } of pairs) {
    if (claimed.has(m) || l.list) continue;
    claimed.add(m);
    l.list = m.type;
    l.bulletU = u;
    if (m.vector) m.vector.used = true;
  }
  // Unclaimed glyphs were not bullets after all: put them back as text so nothing disappears.
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    if (m.piece && !claimed.has(m)) lines.splice(m.insertAt, 0, newLine(m.piece));
  }
  for (const l of lines) {
    const last = l.segments[l.segments.length - 1];
    last.text = last.text.replace(/\s+$/, "");
  }

  const metrics = (l: Line) => {
    const f = fonts.get(l.fontKey);
    return { ascent: f?.ascent || 0.9, descent: f?.descent || -0.22 };
  };
  /** Text drawn one glyph at a time with a consistent gap is letter-spaced. */
  const letterSpacing = (l: Line): number => {
    if (l.pieces < 4 || l.singleChars / l.pieces < 0.6 || l.gaps.length < 2) return 0;
    const sorted = [...l.gaps].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median < 0.02 * l.fontSize || median > 0.5 * l.fontSize) return 0;
    return Math.round(median * 100) / 100;
  };
  const origin = (l: Line) => (l.list ? { x: l.x + l.bulletU * l.cos, y: l.y + l.bulletU * l.sin } : { x: l.x, y: l.y });

  const specFromParas = (paras: Para[]): TextSpec => {
    const first = paras[0].lines[0];
    const allLines = paras.flatMap((p) => p.lines);
    const innerGaps = paras.flatMap((p) => p.gaps);
    // Baseline gaps between consecutive list items become paragraph spacing.
    const itemGaps: number[] = [];
    for (let i = 1; i < paras.length; i++) {
      const prev = paras[i - 1].lines[paras[i - 1].lines.length - 1];
      const next = paras[i].lines[0];
      const dx = next.x - prev.x, dy = next.y - prev.y;
      itemGaps.push(-dx * prev.sin + dy * prev.cos);
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const lineHeight = innerGaps.length ? mean(innerGaps) : itemGaps.length ? mean(itemGaps) : null;
    const paragraphSpacing = innerGaps.length && itemGaps.length ? Math.max(0, mean(itemGaps) - lineHeight!) : 0;
    // Nesting: each distinct bullet indent (more than 1.5em apart) is one level deeper.
    const o = origin(first);
    const indentOf = (l: Line) => { const p = origin(l); return (p.x - o.x) * first.cos + (p.y - o.y) * first.sin; };
    const indents: number[] = [];
    for (const d of paras.filter((p) => p.list).map((p) => indentOf(p.lines[0])).sort((a, b) => a - b)) {
      if (!indents.length || d - indents[indents.length - 1] > 1.5 * first.fontSize) indents.push(d);
    }
    const levelOf = (p: Para) => {
      const d = indentOf(p.lines[0]);
      let best = 0;
      indents.forEach((x, i) => { if (Math.abs(x - d) < Math.abs(indents[best] - d)) best = i; });
      return best;
    };
    const listItems: NonNullable<TextSpec["listItems"]> = [];
    const segments: TextSegment[] = [];
    paras.forEach((para, pi) => {
      const listItem = para.list ? { type: para.list, level: levelOf(para) } : null;
      para.lines.forEach((l, li) => {
        const sep = li === 0 ? "\n" : mode === "flow" ? " " : para.list ? " " : "\n";
        if (pi > 0 || li > 0) segments[segments.length - 1].text += sep;
        // One entry per "\n"-separated paragraph of the node's text.
        if ((pi === 0 && li === 0) || sep === "\n") listItems.push(listItem);
        for (const s of l.segments) {
          const last = segments[segments.length - 1];
          if (last && last.fontName === s.fontName && Math.abs(last.fontSize - s.fontSize) < 0.01 && sameColor(last, s)) {
            last.text += s.text;
          } else {
            segments.push({ ...s });
          }
        }
      });
    });
    return {
      segments,
      letterSpacing: letterSpacing(first),
      x: o.x,
      y: o.y,
      angle: (first.angle * 180) / Math.PI,
      // Widest line measured from the node's left edge (bullets and nested indents included).
      width: Math.max(...allLines.map((l) => (l.x - o.x) * first.cos + (l.y - o.y) * first.sin + l.end - l.start)),
      fontSize: first.fontSize,
      lineHeight,
      paragraphSpacing: paragraphSpacing > 0.5 ? Math.round(paragraphSpacing * 100) / 100 : 0,
      lineCount: allLines.length,
      list: paras[0].list,
      listItems: paras[0].list ? listItems : null,
      ...metrics(first),
    };
  };

  if (mode === "lines") return lines.map((l) => specFromParas([{ lines: [l], gaps: [], list: l.list }]));

  // 3. Lines → paragraphs (a bullet always starts a new one)
  const paras: Para[] = [];
  let para: Para | null = null;
  for (const l of lines) {
    if (para && !l.list) {
      const prev = para.lines[para.lines.length - 1];
      const dx = l.x - prev.x;
      const dy = l.y - prev.y;
      const u = dx * prev.cos + dy * prev.sin;
      const v = -dx * prev.sin + dy * prev.cos; // baseline distance (positive = next line below)
      const fs = prev.fontSize;
      const sameAngle = Math.abs(l.angle - prev.angle) < 0.01;
      const sameSize = Math.abs(l.fontSize - fs) < 0.6;
      const gapOk = v > 0.75 * fs && v < 2.4 * fs;
      const lastGap = para.gaps[para.gaps.length - 1];
      const consistent = lastGap === undefined || Math.abs(v - lastGap) < 0.2 * lastGap + 0.5;
      // Continuation lines share the left edge (a hanging first-line indent of up to 3em is fine).
      const aligned = u > -3 * fs && u < 1.5 * fs;
      if (sameAngle && sameSize && gapOk && consistent && aligned) {
        para.lines.push(l);
        para.gaps.push(v);
        continue;
      }
    }
    para = { lines: [l], gaps: [], list: l.list };
    paras.push(para);
  }

  // 4. Consecutive list items (including nested ones) → one list text node
  const specs: TextSpec[] = [];
  let group: Para[] = [];
  const flushGroup = () => {
    if (group.length) specs.push(specFromParas(group));
    group = [];
  };
  for (const p of paras) {
    if (group.length && p.list && group[0].list) {
      const prevPara = group[group.length - 1];
      const prev = prevPara.lines[prevPara.lines.length - 1];
      const l = p.lines[0];
      const dx = l.x - prev.x;
      const dy = l.y - prev.y;
      const v = -dx * prev.sin + dy * prev.cos;
      const fs = prev.fontSize;
      const top = group[0].lines[0];
      const a = origin(l), b = origin(top);
      const indent = (a.x - b.x) * top.cos + (a.y - b.y) * top.sin;
      // Same level must be the same list type; deeper levels (sub-lists) may differ.
      const nested = indent >= 1.5 * fs && indent < 8 * fs;
      const sibling = Math.abs(indent) < 1.5 * fs && p.list === group[0].list;
      const sizeOk = Math.abs(l.fontSize - fs) < 0.6 || (nested && Math.abs(l.fontSize - fs) < 0.25 * fs);
      if (Math.abs(l.angle - prev.angle) < 0.01 && sizeOk && v > 0.75 * fs && v < 2.6 * fs && (nested || sibling)) {
        group.push(p);
        continue;
      }
    }
    flushGroup();
    group = [p];
  }
  flushGroup();
  return specs;
}

function sameColor(a: TextSegment, b: TextSegment): boolean {
  return (
    Math.abs(a.color.r - b.color.r) < 0.002 &&
    Math.abs(a.color.g - b.color.g) < 0.002 &&
    Math.abs(a.color.b - b.color.b) < 0.002 &&
    Math.abs(a.opacity - b.opacity) < 0.002
  );
}
