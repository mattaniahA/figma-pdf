import { describe, expect, it } from "vitest";
import { parsePdfFontName, normalizeFamily } from "../src/main/fonts";

describe("parsePdfFontName", () => {
  it("strips subset tags and MT suffixes", () => {
    const p = parsePdfFontName({ name: "ABCDEF+Arial-BoldMT", bold: false, italic: false });
    expect(p.family).toBe("arial");
    expect(p.weight).toBe(700);
    expect(p.italic).toBe(false);
  });
  it("reads style words after the dash", () => {
    const p = parsePdfFontName({ name: "OpenSans-SemiBoldItalic", bold: false, italic: false });
    expect(p.family).toBe("opensans");
    expect(p.weight).toBe(600);
    expect(p.italic).toBe(true);
  });
  it("handles comma-separated styles and glued weights", () => {
    expect(parsePdfFontName({ name: "Calibri,Bold", bold: false, italic: false }).weight).toBe(700);
    const glued = parsePdfFontName({ name: "HelveticaNeueLight", bold: false, italic: false });
    expect(glued.family).toBe("helveticaneue");
    expect(glued.weight).toBe(300);
  });
  it("falls back to descriptor flags", () => {
    const p = parsePdfFontName({ name: "CustomFont", bold: true, italic: true });
    expect(p.weight).toBe(700);
    expect(p.italic).toBe(true);
  });
  it("normalizes families", () => {
    expect(normalizeFamily("Times New Roman")).toBe("timesnewroman");
  });
});
