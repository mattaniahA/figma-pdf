import { describe, expect, it } from "vitest";
import { extractTexts, type FontInfo } from "../src/ui/pdf/extractText";
import type { GlyphRun } from "../src/ui/pdf/walkOps";

const H = 200;
const vt: [number, number, number, number, number, number] = [1, 0, 0, -1, 0, H];
const item = (str: string, x: number, y: number, size = 10, fontName = "f1", extra: Partial<{ hasEOL: boolean; width: number }> = {}) => ({
  str, dir: "ltr", transform: [size, 0, 0, size, x, y], width: extra.width ?? str.length * size * 0.5, height: size, fontName, hasEOL: extra.hasEOL ?? false,
});
const fonts = new Map<string, FontInfo>([
  ["f1", { name: "Helvetica", bold: false, italic: false, ascent: 0.9, descent: -0.2 }],
  ["f2", { name: "Helvetica-Bold", bold: true, italic: false, ascent: 0.9, descent: -0.2 }],
]);
const run = (text: string, r = 0): GlyphRun => ({ text, color: { r, g: 0, b: 0 }, opacity: 1, visible: true });

describe("extractTexts", () => {
  it("joins adjacent items on a line and inserts a space for gaps", () => {
    const tc = { items: [item("Hello", 10, 100), item("world", 40, 100)], styles: {} } as any;
    const [spec] = extractTexts(tc, vt, fonts, [run("Hello"), run("world")], "lines");
    expect(spec.segments.map((s) => s.text).join("")).toBe("Hello world");
    expect(spec.y).toBe(H - 100);
    expect(spec.fontSize).toBe(10);
  });

  it("keeps styled runs as separate segments with their colours", () => {
    const tc = { items: [item("Plain ", 10, 100), item("Bold", 40, 100, 10, "f2")], styles: {} } as any;
    const [spec] = extractTexts(tc, vt, fonts, [run("Plain "), run("Bold", 1)], "lines");
    expect(spec.segments).toHaveLength(2);
    expect(spec.segments[1].bold).toBe(true);
    expect(spec.segments[1].color.r).toBe(1);
  });

  it("groups consecutive lines into a paragraph with a line height", () => {
    const tc = { items: [item("Line one", 10, 100, 10, "f1", { hasEOL: true }), item("Line two", 10, 88), item("Far away", 10, 20)], styles: {} } as any;
    const specs = extractTexts(tc, vt, fonts, [run("Line one"), run("Line two"), run("Far away")], "keepBreaks");
    expect(specs).toHaveLength(2);
    expect(specs[0].segments.map((s) => s.text).join("")).toBe("Line one\nLine two");
    expect(specs[0].lineHeight).toBeCloseTo(12);
    expect(specs[0].lineCount).toBe(2);
  });

  it("flow mode joins lines with spaces", () => {
    const tc = { items: [item("a b", 10, 100, 10, "f1", { hasEOL: true }), item("c d", 10, 88)], styles: {} } as any;
    const [spec] = extractTexts(tc, vt, fonts, [run("a b"), run("c d")], "flow");
    expect(spec.segments[0].text).toBe("a b c d");
  });

  it("drops invisible (OCR) text and survives ligature drift", () => {
    const tc = { items: [item("fine", 10, 100), item("hidden", 10, 50), item("next", 10, 20)], styles: {} } as any;
    const runs = [run("ﬁne"), { ...run("hidden"), visible: false }, run("next", 1)];
    const specs = extractTexts(tc, vt, fonts, runs, "lines");
    expect(specs.map((s) => s.segments[0].text)).toEqual(["fine", "next"]);
    expect(specs[1].segments[0].color.r).toBe(1);
  });

  it("reports rotation for vertical text", () => {
    const tc = { items: [{ ...item("Up", 50, 50), transform: [0, 10, -10, 0, 50, 50] }], styles: {} } as any;
    const [spec] = extractTexts(tc, vt, fonts, [run("Up")], "lines");
    expect(spec.angle).toBeCloseTo(-90);
  });
});
