import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import type { Matrix, TextSegment, TextSpec } from "../../shared/types";
import { mul } from "./geometry";
import type { BulletCandidate, GlyphRun } from "./walkOps";

export interface FontInfo {
  name: string;
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

const isSpace = (s: string) => /^\s*$/.test(s);
const BULLET_GLYPH = /^[\u2022\u00b7\u25e6\u25aa\u25ab\u25cf\u25cb\u25a0\u25a1\u2023\u2043\u2013\u2014*\u2219-]$/;
const ORDERED_GLYPH = /^\d{1,2}[.)]$/;
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
  let line: Line | null = null;
  let prevEol = false;
  let pendingBullet: { x: number; y: number; angle: number; fontSize: number; type: ListType } | null = null;
  const segFor = (p: Piece, text: string): TextSegment => {
    const f = fonts.get(p.fontKey);
    return {
      text,
      fontName: f?.name ?? p.fontKey,
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
      // A lone bullet / number glyph at the start of a line marks a list item.
      const t = p.text.trim();
      if (BULLET_GLYPH.test(t) || ORDERED_GLYPH.test(t)) {
        pendingBullet = { x: p.x, y: p.y, angle: p.angle, fontSize: p.fontSize, type: BULLET_GLYPH.test(t) ? "UNORDERED" : "ORDERED" };
        prevEol = p.eol;
        continue;
      }
      line = {
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
      };
      if (pendingBullet) {
        const dx = pendingBullet.x - line.x;
        const dy = pendingBullet.y - line.y;
        const u = dx * line.cos + dy * line.sin;
        const v = -dx * line.sin + dy * line.cos;
        if (Math.abs(pendingBullet.angle - line.angle) < 0.01 && Math.abs(v) < 0.4 * line.fontSize && u < -0.1 * line.fontSize && u > -4 * line.fontSize) {
          line.list = pendingBullet.type;
          line.bulletU = u;
        }
        pendingBullet = null;
      }
      lines.push(line);
    }
    prevEol = p.eol;
  }
  for (const l of lines) {
    const last = l.segments[l.segments.length - 1];
    last.text = last.text.replace(/\s+$/, "");
  }

  // 2b. Vector bullets (dots drawn as paths) sitting just left of a line.
  for (const b of bullets) {
    if (b.used) continue;
    for (const l of lines) {
      if (l.list) continue;
      const dx = b.cx - l.x;
      const dy = b.cy - l.y;
      const u = dx * l.cos + dy * l.sin;
      const v = -dx * l.sin + dy * l.cos;
      const fs = l.fontSize;
      if (u < -0.15 * fs && u > -3.5 * fs && v < 0.15 * fs && v > -0.85 * fs) {
        l.list = "UNORDERED";
        l.bulletU = u - Math.max(b.width, b.height) / 2;
        b.used = true;
        break;
      }
    }
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
    const segments: TextSegment[] = [];
    paras.forEach((para, pi) => {
      para.lines.forEach((l, li) => {
        if (pi > 0 || li > 0) {
          const sep = li === 0 ? "\n" : mode === "flow" ? " " : para.list ? " " : "\n";
          segments[segments.length - 1].text += sep;
        }
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
    const o = origin(first);
    return {
      segments,
      letterSpacing: letterSpacing(first),
      x: o.x,
      y: o.y,
      angle: (first.angle * 180) / Math.PI,
      width: Math.max(...allLines.map((l) => l.end - l.start - Math.min(0, l.bulletU))),
      fontSize: first.fontSize,
      lineHeight,
      paragraphSpacing: paragraphSpacing > 0.5 ? Math.round(paragraphSpacing * 100) / 100 : 0,
      lineCount: allLines.length,
      list: paras[0].list,
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

  // 4. Consecutive list items → one list text node
  const specs: TextSpec[] = [];
  let group: Para[] = [];
  const flushGroup = () => {
    if (group.length) specs.push(specFromParas(group));
    group = [];
  };
  for (const p of paras) {
    if (group.length && p.list && p.list === group[0].list) {
      const prevPara = group[group.length - 1];
      const prev = prevPara.lines[prevPara.lines.length - 1];
      const l = p.lines[0];
      const dx = l.x - prev.x;
      const dy = l.y - prev.y;
      const v = -dx * prev.sin + dy * prev.cos;
      const fs = prev.fontSize;
      const bulletAligned = Math.abs(origin(l).x - origin(group[0].lines[0]).x) < 1.5 * fs;
      if (Math.abs(l.angle - prev.angle) < 0.01 && Math.abs(l.fontSize - fs) < 0.6 && v > 0.75 * fs && v < 2.6 * fs && bulletAligned) {
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
