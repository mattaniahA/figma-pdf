import { describe, expect, it } from "vitest";
import { OPS } from "pdfjs-dist";
import { walkOps } from "../src/ui/pdf/walkOps";

type Op = [number, unknown[]];
function fakePage(ops: Op[]) {
  return {
    getOperatorList: async () => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]) }),
    objs: { has: () => false, get: () => null },
    commonObjs: { has: () => false, get: () => null },
  } as any;
}
const vt: [number, number, number, number, number, number] = [1, 0, 0, -1, 0, 100];
const rect = (x: number, y: number, w: number, h: number) => new Float32Array([0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 4]);
const walk = (ops: Op[]) => walkOps(fakePage(ops), vt, 100, 100, null, { vectors: true, images: true });

describe("walkOps", () => {
  it("emits filled paths with the current fill colour and page transform", async () => {
    const r = await walk([
      [OPS.setFillRGBColor, ["#ff0000"]],
      [OPS.constructPath, [OPS.fill, [rect(10, 10, 20, 30)], [10, 10, 30, 40]]],
    ]);
    expect(r.elements).toHaveLength(1);
    const svg = (r.elements[0] as any).vector.svg;
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('transform="matrix(1 0 0 -1 0 100)"');
    expect(svg).toContain("M10 10L30 10L30 40L10 40Z");
  });

  it("applies clips as nested groups and drops page-sized clips", async () => {
    const r = await walk([
      [OPS.clip, []],
      [OPS.constructPath, [OPS.endPath, [rect(0, 0, 100, 100)], null]],
      [OPS.save, []],
      [OPS.clip, []],
      [OPS.constructPath, [OPS.endPath, [rect(0, 0, 50, 50)], null]],
      [OPS.constructPath, [OPS.fill, [rect(0, 0, 100, 100)], null]],
      [OPS.restore, []],
      [OPS.constructPath, [OPS.fill, [rect(60, 60, 10, 10)], null]],
    ]);
    const svg = (r.elements[0] as any).vector.svg;
    expect((svg.match(/<clipPath/g) || []).length).toBe(1);
    expect(svg).toMatch(/<g clip-path="url\(#c1\)"><path[^>]*\/><\/g><path/);
  });

  it("records text colours and visibility, skipping text in the SVG", async () => {
    const r = await walk([
      [OPS.setFillRGBColor, ["#00ff00"]],
      [OPS.showText, [[{ unicode: "H" }, { unicode: "i" }, -250]]],
      [OPS.setTextRenderingMode, [3]],
      [OPS.showText, [[{ unicode: "x" }]]],
    ]);
    expect(r.elements).toHaveLength(0);
    expect(r.runs).toEqual([
      { text: "Hi", color: { r: 0, g: 1, b: 0 }, opacity: 1, visible: true },
      { text: "x", color: { r: 0, g: 1, b: 0 }, opacity: 1, visible: false },
    ]);
  });

  it("uses stroke attributes and dashes", async () => {
    const r = await walk([
      [OPS.setStrokeRGBColor, ["#0000ff"]],
      [OPS.setLineWidth, [2]],
      [OPS.setDash, [[4, 2], 0]],
      [OPS.constructPath, [OPS.stroke, [new Float32Array([0, 0, 0, 1, 10, 10])], null]],
    ]);
    const svg = (r.elements[0] as any).vector.svg;
    expect(svg).toContain('stroke="#0000ff" stroke-width="2"');
    expect(svg).toContain('stroke-dasharray="4 2"');
    expect(svg).toContain('fill="none"');
  });
});
