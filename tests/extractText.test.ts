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

describe("lists", () => {
  it("turns bullet glyphs into list items and merges consecutive items", () => {
    const tc = { items: [
      item("•", 10, 100), item("First item", 20, 100, 10, "f1", { hasEOL: true }),
      item("continues here", 20, 88, 10, "f1", { hasEOL: true }),
      item("•", 10, 76), item("Second item", 20, 76),
    ], styles: {} } as any;
    const runs = [run("•"), run("First item"), run("continues here"), run("•"), run("Second item")];
    const specs = extractTexts(tc, vt, fonts, runs, "keepBreaks");
    expect(specs).toHaveLength(1);
    expect(specs[0].list).toBe("UNORDERED");
    expect(specs[0].segments.map((s) => s.text).join("")).toBe("First item continues here\nSecond item");
    expect(specs[0].x).toBe(10);
  });

  it("claims vector dots left of a line as bullets", () => {
    const tc = { items: [item("Dot item", 20, 100)], styles: {} } as any;
    const dot = { cx: 13, cy: H - 103, width: 3, height: 3, markup: "<path/>", clips: [], used: false };
    const far = { cx: 150, cy: 20, width: 3, height: 3, markup: "<path/>", clips: [], used: false };
    const [spec] = extractTexts(tc, vt, fonts, [run("Dot item")], "keepBreaks", [dot, far]);
    expect(spec.list).toBe("UNORDERED");
    expect(dot.used).toBe(true);
    expect(far.used).toBe(false);
    expect(spec.x).toBeCloseTo(11.5);
  });

  it("claims bullets drawn after their (multi-line) item text", () => {
    const tc = { items: [
      item("First item", 20, 100, 10, "f1", { hasEOL: true }), item("wraps here", 20, 88, 10, "f1", { hasEOL: true }),
      item("•", 10, 100, 10, "f1", { hasEOL: true }),
      item("Second item", 20, 74, 10, "f1", { hasEOL: true }),
      item("•", 10, 74),
    ], styles: {} } as any;
    const runs = [run("First item"), run("wraps here"), run("•"), run("Second item"), run("•")];
    const specs = extractTexts(tc, vt, fonts, runs, "keepBreaks");
    expect(specs).toHaveLength(1);
    expect(specs[0].list).toBe("UNORDERED");
    expect(specs[0].segments.map((s) => s.text).join("")).toBe("First item wraps here\nSecond item");
    expect(specs[0].listItems).toEqual([{ type: "UNORDERED", level: 0 }, { type: "UNORDERED", level: 0 }]);
    expect(specs[0].x).toBe(10);
  });

  it("keeps a bullet glyph with no item next to it as text", () => {
    const tc = { items: [item("Title", 10, 150, 10, "f1", { hasEOL: true }), item("•", 100, 100)], styles: {} } as any;
    const specs = extractTexts(tc, vt, fonts, [run("Title"), run("•")], "keepBreaks");
    expect(specs.map((s) => s.segments[0].text)).toEqual(["Title", "•"]);
    expect(specs.every((s) => s.list === null)).toBe(true);
  });

  it("splits markers that share a text item with the item text", () => {
    const tc = { items: [
      item("• Apples", 10, 100, 10, "f1", { hasEOL: true }), item("• Pears", 10, 88, 10, "f1", { hasEOL: true }),
      item("2. Step two", 10, 50),
    ], styles: {} } as any;
    const specs = extractTexts(tc, vt, fonts, [run("• Apples"), run("• Pears"), run("2. Step two")], "keepBreaks");
    expect(specs).toHaveLength(2);
    expect(specs[0].list).toBe("UNORDERED");
    expect(specs[0].segments[0].text).toBe("Apples\nPears");
    expect(specs[0].x).toBe(10);
    expect(specs[1].list).toBe("ORDERED");
    expect(specs[1].segments[0].text).toBe("Step two");
  });

  it("recognises Symbol-font private-use bullets", () => {
    const tc = { items: [item("", 10, 100), item("Word bullet", 25, 100)], styles: {} } as any;
    const [spec] = extractTexts(tc, vt, fonts, [run(""), run("Word bullet")], "keepBreaks");
    expect(spec.list).toBe("UNORDERED");
    expect(spec.segments[0].text).toBe("Word bullet");
  });

  it("keeps nested items in the parent list with an indent level", () => {
    const tc = { items: [
      item("•", 10, 100), item("Parent", 20, 100, 10, "f1", { hasEOL: true }),
      item("◦", 28, 88), item("Child", 38, 88, 10, "f1", { hasEOL: true }),
      item("•", 10, 76), item("Sibling", 20, 76),
    ], styles: {} } as any;
    const runs = ["•", "Parent", "◦", "Child", "•", "Sibling"].map((t) => run(t));
    const specs = extractTexts(tc, vt, fonts, runs, "keepBreaks");
    expect(specs).toHaveLength(1);
    expect(specs[0].segments[0].text).toBe("Parent\nChild\nSibling");
    expect(specs[0].listItems!.map((i) => i!.level)).toEqual([0, 1, 0]);
  });

  it("keeps inline dashes as text", () => {
    const tc = { items: [item("a", 10, 100), item("-", 17, 100), item("b", 24, 100)], styles: {} } as any;
    const [spec] = extractTexts(tc, vt, fonts, [run("a"), run("-"), run("b")], "lines");
    expect(spec.list).toBeNull();
    expect(spec.segments[0].text).toBe("a-b");
  });
});

describe("paragraph alignment", () => {
  it("does not merge a right-aligned date with the left-aligned line below it", () => {
    const tc = { items: [
      item("6/2020 – 6/2024", 300, 100, 10, "f1", { hasEOL: true, width: 70 }),
      item("One of three engineers on the team across every surface", 10, 88, 10, "f1", { width: 360 }),
    ], styles: {} } as any;
    const specs = extractTexts(tc, vt, fonts, [run("6/2020 – 6/2024"), run("One of three engineers on the team across every surface")], "keepBreaks");
    expect(specs).toHaveLength(2);
    expect(specs[1].x).toBe(10);
  });
});
