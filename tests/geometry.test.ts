import { describe, expect, it } from "vitest";
import { apply, mul, parseCssColor } from "../src/ui/pdf/geometry";
import { unitSquareToPlacement } from "../src/ui/pdf/images";

describe("matrix helpers", () => {
  it("composes like pdf.js Util.transform", () => {
    const flip: [number, number, number, number, number, number] = [1, 0, 0, -1, 0, 100];
    const move: [number, number, number, number, number, number] = [1, 0, 0, 1, 10, 20];
    const m = mul(flip, move);
    expect(apply(m, 0, 0)).toEqual([10, 80]);
  });
  it("parses colours", () => {
    expect(parseCssColor("#ff0080")).toEqual({ r: 1, g: 0, b: 128 / 255 });
    expect(parseCssColor("rgb(0, 255, 0)")).toEqual({ r: 0, g: 1, b: 0 });
    expect(parseCssColor(null)).toBeNull();
  });
});

describe("unitSquareToPlacement", () => {
  it("maps an upright image", () => {
    // 200x100 image at (10,20) in a y-down space: ctm = [200,0,0,-100,10,120]
    const p = unitSquareToPlacement([200, 0, 0, -100, 10, 120]);
    expect(p.width).toBe(200);
    expect(p.height).toBe(100);
    expect(p.transform.map((v) => v + 0)).toEqual([1, 0, 0, 1, 10, 20]);
  });
});
