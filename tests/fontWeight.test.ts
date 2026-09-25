import { describe, expect, it } from "vitest";
import { OPS } from "pdfjs-dist";
import { estimateType3Weights, pathArea } from "../src/ui/pdf/fontWeight";

// A glyph drawn as one w×h rectangle (DrawOPS: move, 3 lines, close).
const rect = (w: number, h = 100) => ({
  fnArray: [OPS.constructPath],
  argsArray: [[OPS.fill, [new Float32Array([0, 0, 0, 1, w, 0, 1, w, h, 1, 0, h, 4])], null]],
});
const CHARS = ["a", "b", "c", "d", "e"];
const type3 = (name: string, stem: number, chars = CHARS) => ({
  name,
  differences: chars.map((_, i) => `g${i}`),
  toUnicode: { _map: chars },
  charProcOperatorList: Object.fromEntries(chars.map((_, i) => [`g${i}`, rect(stem)])),
});

describe("pathArea", () => {
  it("measures a rectangle and subtracts an opposite-wound counter", () => {
    expect(pathArea([0, 0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 10, 4])).toBeCloseTo(100);
    const ring = [0, 0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 10, 4, 0, 2, 2, 1, 2, 8, 1, 8, 8, 1, 8, 2, 4];
    expect(pathArea(ring)).toBeCloseTo(64);
  });
});

describe("estimateType3Weights", () => {
  it("rates subsets of one family against its most-used (body) font", () => {
    const weights = estimateType3Weights([
      { key: "body", font: type3("AAAAAA+DMSans9pt-Regular", 100), chars: 900 },
      { key: "strong", font: type3("BAAAAA+DMSans9pt-Regular", 138), chars: 200 },
      { key: "role", font: type3("CAAAAA+DMSans9pt-Regular", 117), chars: 30 },
      { key: "italic", font: type3("DAAAAA+DMSans9pt-Italic", 100), chars: 300 },
    ]);
    expect(Object.fromEntries(weights)).toEqual({ body: 400, strong: 600, role: 500, italic: 400 });
  });

  it("ignores non-Type3 fonts and fonts with too few shared glyphs", () => {
    const weights = estimateType3Weights([
      { key: "body", font: type3("AAAAAA+Foo-Regular", 100), chars: 900 },
      { key: "few", font: type3("BAAAAA+Foo-Regular", 150, ["a", "b", "x", "y", "z"]), chars: 10 },
      { key: "truetype", font: { name: "Arial-BoldMT" }, chars: 50 },
    ]);
    expect(weights.has("few")).toBe(false);
    expect(weights.has("truetype")).toBe(false);
  });
});
