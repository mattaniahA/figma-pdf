import type { Matrix, RGB } from "../../shared/types";

/** m1 ∘ m2: apply m2 first, then m1 (pdf.js `Util.transform` convention). */
export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

export function matrixAttr(m: Matrix): string {
  return `matrix(${m.map(fmt).join(" ")})`;
}

/** Parse a CSS colour string emitted by pdf.js ("#rrggbb" or "rgb(r, g, b)"). */
export function parseCssColor(css: string | null | undefined): RGB | null {
  if (!css) return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const v = parseInt(hex[1], 16);
    return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(css.trim());
  if (rgb) {
    return { r: +rgb[1] / 255, g: +rgb[2] / 255, b: +rgb[3] / 255 };
  }
  return null;
}
