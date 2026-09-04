import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import type { Matrix, TextSegment, TextSpec } from "../../shared/types";
import { mul } from "./geometry";
import type { GlyphRun } from "./walkOps";

export interface FontInfo {
  name: string;
  bold: boolean;
  italic: boolean;
  ascent: number;
  descent: number;
}

export type TextMode = "lines" | "keepBreaks" | "flow";

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
}

const isSpace = (s: string) => /^\s*$/.test(s);

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
      const probe = want.slice(0, 2).join("");
      for (let j = cursor; j < Math.min(chars.length, cursor + 80); j++) {
        if (chars[j] === want[0] && (want.length < 2 || chars[j + 1] === want[1]) && probe) {
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
      };
      lines.push(line);
    }
    prevEol = p.eol;
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
  const toSpec = (l: Line): TextSpec => ({
    segments: l.segments,
    letterSpacing: letterSpacing(l),
    x: l.x,
    y: l.y,
    angle: (l.angle * 180) / Math.PI,
    width: l.end - l.start,
    fontSize: l.fontSize,
    lineHeight: null,
    lineCount: 1,
    ...metrics(l),
  });

  if (mode === "lines") return lines.map(toSpec);

  // 3. Lines → paragraphs
  const specs: TextSpec[] = [];
  let para: { lines: Line[]; gaps: number[] } | null = null;
  const flush = () => {
    if (!para) return;
    const first = para.lines[0];
    if (para.lines.length === 1) {
      specs.push(toSpec(first));
    } else {
      const lineHeight = para.gaps.reduce((a, b) => a + b, 0) / para.gaps.length;
      const segments: TextSegment[] = [];
      para.lines.forEach((l, i) => {
        if (i > 0) {
          const sep = mode === "flow" ? " " : "\n";
          const last = segments[segments.length - 1];
          last.text += sep;
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
      specs.push({
        segments,
        letterSpacing: letterSpacing(first),
        x: first.x,
        y: first.y,
        angle: (first.angle * 180) / Math.PI,
        width: Math.max(...para.lines.map((l) => l.end - l.start)),
        fontSize: first.fontSize,
        lineHeight,
        lineCount: para.lines.length,
        ...metrics(first),
      });
    }
    para = null;
  };
  for (const l of lines) {
    if (para) {
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
      const overlap = u < prev.end - prev.start && u > -(l.end - l.start) - 1.5 * fs;
      if (sameAngle && sameSize && gapOk && consistent && overlap) {
        para.lines.push(l);
        para.gaps.push(v);
        continue;
      }
      flush();
    }
    para = { lines: [l], gaps: [] };
  }
  flush();
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
