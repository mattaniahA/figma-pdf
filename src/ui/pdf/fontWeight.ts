import { OPS } from "pdfjs-dist";
import { D_CLOSE, D_CURVE, D_LINE, D_MOVE, D_QUAD } from "./walkOps";

type PathData = ArrayLike<number>;

/** The parts of a pdf.js Type3 font object (with fontExtraProperties) that we read. */
export interface Type3FontLike {
  name?: string;
  differences?: (string | undefined)[];
  toUnicode?: { _map?: (string | undefined)[]; get?: (code: number) => string | undefined } | null;
  charProcOperatorList?: Record<string, { fnArray: number[]; argsArray: unknown[] }>;
}

export interface WeightInput {
  key: string;
  font: Type3FontLike | null;
  /** Characters drawn with this font on the page; the most used font of a family is taken as Regular. */
  chars: number;
}

/** Ink ratio → weight, fitted on DM Sans (1.00 → 400, 1.17 → 500, 1.38 → 600). */
const WEIGHT_PER_RATIO = 530;

/**
 * Type3 fonts (e.g. variable fonts printed by Chrome) carry no weight: every
 * subset is named "-Regular". Their glyph outlines do, so compare the ink area
 * of the same characters against the family's body-text font.
 */
export function estimateType3Weights(inputs: WeightInput[]): Map<string, number> {
  const out = new Map<string, number>();
  const families = new Map<string, { key: string; chars: number; ink: Map<string, number> }[]>();
  for (const { key, font, chars } of inputs) {
    if (!font?.charProcOperatorList || !font.differences) continue;
    const ink = glyphInk(font);
    if (ink.size < 3) continue;
    const family = (font.name ?? "").replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0];
    if (!families.has(family)) families.set(family, []);
    families.get(family)!.push({ key, chars, ink });
  }
  for (const members of families.values()) {
    const base = members.reduce((a, b) => (b.chars > a.chars ? b : a));
    for (const m of members) {
      if (m === base) { out.set(m.key, 400); continue; }
      const ratios: number[] = [];
      for (const [ch, area] of m.ink) {
        const b = base.ink.get(ch);
        if (b) ratios.push(area / b);
      }
      if (ratios.length < 3) continue;
      ratios.sort((a, b) => a - b);
      const median = ratios[ratios.length >> 1];
      const w = Math.round((400 + (median - 1) * WEIGHT_PER_RATIO) / 100) * 100;
      out.set(m.key, Math.min(900, Math.max(100, w)));
    }
  }
  return out;
}

/** Filled area of each letter / digit glyph, keyed by its unicode character. */
function glyphInk(font: Type3FontLike): Map<string, number> {
  const ink = new Map<string, number>();
  const toUni = (code: number) => font.toUnicode?._map?.[code] ?? font.toUnicode?.get?.(code);
  font.differences!.forEach((glyph, code) => {
    const ch = glyph ? toUni(code) : undefined;
    const proc = glyph ? font.charProcOperatorList![glyph] : undefined;
    if (!ch || !proc || !/^[A-Za-z0-9]$/.test(ch) || ink.has(ch)) return;
    let area = 0;
    proc.fnArray.forEach((fn, i) => {
      if (fn !== OPS.constructPath) return;
      const data = (proc.argsArray[i] as [number, PathData[]])?.[1]?.[0];
      if (data) area += pathArea(data);
    });
    if (area > 0) ink.set(ch, area);
  });
  return ink;
}

/** Absolute shoelace area of a path (outer contours minus counters, as fonts wind them oppositely). */
export function pathArea(d: PathData): number {
  let sum = 0, sx = 0, sy = 0, px = 0, py = 0;
  const to = (x: number, y: number) => { sum += px * y - x * py; px = x; py = y; };
  const close = () => { if (px !== sx || py !== sy) to(sx, sy); };
  const STEPS = 8;
  for (let i = 0; i < d.length; ) {
    switch (d[i++]) {
      case D_MOVE: close(); sx = px = d[i++]; sy = py = d[i++]; break;
      case D_LINE: to(d[i++], d[i++]); break;
      case D_CURVE: {
        const x0 = px, y0 = py, x1 = d[i++], y1 = d[i++], x2 = d[i++], y2 = d[i++], x3 = d[i++], y3 = d[i++];
        for (let s = 1; s <= STEPS; s++) {
          const t = s / STEPS, u = 1 - t;
          to(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
        }
        break;
      }
      case D_QUAD: {
        const x0 = px, y0 = py, x1 = d[i++], y1 = d[i++], x2 = d[i++], y2 = d[i++];
        for (let s = 1; s <= STEPS; s++) {
          const t = s / STEPS, u = 1 - t;
          to(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
        }
        break;
      }
      case D_CLOSE: close(); break;
      default: i = d.length;
    }
  }
  close();
  return Math.abs(sum / 2);
}
