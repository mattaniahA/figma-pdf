import { OPS } from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
type OptionalContentConfig = { isVisible(group: unknown): boolean };
import type { ElementSpec, Matrix, RGB } from "../../shared/types";
import { apply, fmt, matrixAttr, mul, parseCssColor } from "./geometry";
import { imageDataToPng, maskToPng, unitSquareToPlacement, type PdfImageData } from "./images";

export interface GlyphRun {
  text: string;
  color: RGB;
  opacity: number;
  visible: boolean;
}

/** A tiny filled shape that is probably a list bullet; held back from the SVG until text matching decides. */
export interface BulletCandidate {
  cx: number;
  cy: number;
  width: number;
  height: number;
  markup: string;
  clips: string[];
  used: boolean;
}

export interface WalkResult {
  elements: ElementSpec[];
  runs: GlyphRun[];
  warnings: string[];
  bullets: BulletCandidate[];
  /** Builds a vector element from bullet candidates that no text line claimed. */
  leftoverVector(unused: BulletCandidate[]): ElementSpec | null;
}

interface GState {
  ctm: Matrix;
  base: Matrix; // pattern space base (page / form xobject)
  fill: string | null; // css colour or url(#id)
  stroke: string | null;
  lineWidth: number;
  lineCap: number;
  lineJoin: number;
  dash: number[] | null;
  fillAlpha: number;
  strokeAlpha: number;
  clips: string[];
  textMode: number;
}

// DrawOPS encoding used inside constructPath path buffers.
export const D_MOVE = 0, D_LINE = 1, D_CURVE = 2, D_QUAD = 3, D_CLOSE = 4;

const CAPS = ["butt", "round", "square"];
const JOINS = ["miter", "round", "bevel"];
const BLACK: RGB = { r: 0, g: 0, b: 0 };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

interface Shading {
  type: "axial" | "radial";
  bbox: number[] | null;
  stops: [number, string][];
  p0: number[];
  p1: number[];
  r0: number | null;
  r1: number | null;
}

/**
 * Walk a page's operator list producing text-free SVG segments and image
 * placements (in draw order), plus the fill colour of every text-showing op so
 * text items can be coloured later.
 */
export async function walkOps(
  page: PDFPageProxy,
  viewportTransform: Matrix,
  pageWidth: number,
  pageHeight: number,
  ocConfig: OptionalContentConfig | null,
  opts: { vectors: boolean; images: boolean },
): Promise<WalkResult> {
  const { fnArray, argsArray } = await page.getOperatorList();
  const elements: ElementSpec[] = [];
  const runs: GlyphRun[] = [];
  const warnings = new Set<string>();
  const bullets: BulletCandidate[] = [];

  let state: GState = {
    ctm: viewportTransform,
    base: viewportTransform,
    fill: "#000000",
    stroke: "#000000",
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    dash: null,
    fillAlpha: 1,
    strokeAlpha: 1,
    clips: [],
    textMode: 0,
  };
  const stack: GState[] = [];
  let pendingClip: "nonzero" | "evenodd" | null = null;
  const markedVisible: boolean[] = [];
  let contentVisible = true;

  // --- SVG assembly ------------------------------------------------------
  const defs: string[] = [];
  let body: string[] = [];
  let openClips: string[] = [];
  let idCounter = 0;
  let vectorCount = 0;

  const openTo = (clips: string[]) => {
    let common = 0;
    while (common < clips.length && common < openClips.length && clips[common] === openClips[common]) common++;
    for (let i = openClips.length; i > common; i--) body.push("</g>");
    for (let i = common; i < clips.length; i++) body.push(`<g clip-path="url(#${clips[i]})">`);
    openClips = clips.slice();
  };
  const flushSegment = () => {
    openTo([]);
    if (body.length === 0) return;
    vectorCount++;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(pageWidth)}" height="${fmt(pageHeight)}" ` +
      `viewBox="0 0 ${fmt(pageWidth)} ${fmt(pageHeight)}">` +
      (defs.length ? `<defs>${defs.join("")}</defs>` : "") +
      body.join("") +
      `</svg>`;
    elements.push({ kind: "vector", vector: { svg, name: `Vectors ${vectorCount}` } });
    body = [];
  };
  const emit = (markup: string, clips: string[] = state.clips) => {
    if (!opts.vectors || !contentVisible) return;
    openTo(clips);
    body.push(markup);
  };
  const wrapSvg = (defsMarkup: string, inner: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(pageWidth)}" height="${fmt(pageHeight)}" ` +
    `viewBox="0 0 ${fmt(pageWidth)} ${fmt(pageHeight)}">${defsMarkup}${inner}</svg>`;

  /** Bounding box of a path's points in page space (curve control points included). */
  const pathBBox = (data: Float32Array | number[], ctm: Matrix) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const take = (x: number, y: number) => {
      const [px, py] = apply(ctm, x, y);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    };
    for (let i = 0; i < data.length; ) {
      switch (data[i++]) {
        case D_MOVE: case D_LINE: take(data[i++], data[i++]); break;
        case D_CURVE: take(data[i++], data[i++]); take(data[i++], data[i++]); take(data[i++], data[i++]); break;
        case D_QUAD: take(data[i++], data[i++]); take(data[i++], data[i++]); break;
        case D_CLOSE: break;
        default: return null;
      }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  };
  /** Dots, squares and short dashes small enough to be list bullets. */
  const isBulletShaped = (w: number, h: number) =>
    (w >= 0.8 && h >= 0.8 && w <= 9 && h <= 9 && w / h > 0.5 && w / h < 2) || (h <= 2.2 && w >= 3 && w <= 12);

  // --- helpers -------------------------------------------------------------
  const pathToD = (data: Float32Array | number[] | null): string => {
    if (!data) return "";
    const out: string[] = [];
    for (let i = 0; i < data.length; ) {
      switch (data[i++]) {
        case D_MOVE: out.push(`M${fmt(data[i++])} ${fmt(data[i++])}`); break;
        case D_LINE: out.push(`L${fmt(data[i++])} ${fmt(data[i++])}`); break;
        case D_CURVE:
          out.push(`C${fmt(data[i++])} ${fmt(data[i++])} ${fmt(data[i++])} ${fmt(data[i++])} ${fmt(data[i++])} ${fmt(data[i++])}`);
          break;
        case D_QUAD: out.push(`Q${fmt(data[i++])} ${fmt(data[i++])} ${fmt(data[i++])} ${fmt(data[i++])}`); break;
        case D_CLOSE: out.push("Z"); break;
        default: return out.join("");
      }
    }
    return out.join("");
  };

  type BBox = { minX: number; minY: number; maxX: number; maxY: number };
  /** Page-space bounds when the path is a single axis-aligned rectangle (lines only, no rotation). */
  const axisRect = (data: Float32Array | number[] | null, ctm: Matrix): BBox | null => {
    if (!data || Math.abs(ctm[1]) > 1e-6 || Math.abs(ctm[2]) > 1e-6) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, moves = 0, points = 0;
    for (let i = 0; i < data.length; ) {
      const op = data[i++];
      if (op === D_CLOSE) continue;
      if (op !== D_MOVE && op !== D_LINE) return null;
      if (op === D_MOVE && ++moves > 1) return null;
      const [x, y] = apply(ctm, data[i++], data[i++]);
      points++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (points < 4 || points > 5) return null;
    // Every vertex must sit on a corner of the bounds.
    const eq = (a: number, b: number) => Math.abs(a - b) < 0.01;
    for (let i = 0; i < data.length; ) {
      const op = data[i++];
      if (op === D_CLOSE) continue;
      const [x, y] = apply(ctm, data[i++], data[i++]);
      if (!(eq(x, minX) || eq(x, maxX)) || !(eq(y, minY) || eq(y, maxY))) return null;
    }
    return { minX, minY, maxX, maxY };
  };
  /** True when the (line-only) path, transformed by ctm, is an axis-aligned rect covering the page. */
  const coversPage = (data: Float32Array | number[] | null, ctm: Matrix): boolean => {
    const r = axisRect(data, ctm);
    return !!r && r.minX <= 0.01 && r.minY <= 0.01 && r.maxX >= pageWidth - 0.01 && r.maxY >= pageHeight - 0.01;
  };
  /** Rectangular clips (page space), so clips that don't cut anything can be left out. */
  const rectClips = new Map<string, BBox>();
  const clipsFor = (bb: BBox | null): string[] => {
    if (!bb) return state.clips;
    return state.clips.filter((id) => {
      const r = rectClips.get(id);
      return !(r && bb.minX >= r.minX - 0.01 && bb.minY >= r.minY - 0.01 && bb.maxX <= r.maxX + 0.01 && bb.maxY <= r.maxY + 0.01);
    });
  };

  const strokeAttrs = (): string => {
    const scale = Math.sqrt(Math.abs(state.ctm[0] * state.ctm[3] - state.ctm[1] * state.ctm[2])) || 1;
    const lw = state.lineWidth > 0 ? state.lineWidth : 0.8 / scale;
    let s = ` stroke="${state.stroke}" stroke-width="${fmt(lw)}"`;
    if (state.lineCap) s += ` stroke-linecap="${CAPS[state.lineCap] ?? "butt"}"`;
    if (state.lineJoin) s += ` stroke-linejoin="${JOINS[state.lineJoin] ?? "miter"}"`;
    if (state.dash && state.dash.length && state.dash.some((v) => v > 0)) s += ` stroke-dasharray="${state.dash.map(fmt).join(" ")}"`;
    if (state.strokeAlpha < 1) s += ` stroke-opacity="${fmt(state.strokeAlpha)}"`;
    return s;
  };

  const paintPath = (d: string, doFill: boolean, doStroke: boolean, evenOdd: boolean, data: Float32Array | null = null) => {
    if (!d) return;
    const fill = doFill && state.fill ? state.fill : null;
    const stroke = doStroke && state.stroke ? state.stroke : null;
    if (!fill && !stroke) return;
    let bb: BBox | null = data ? pathBBox(data, state.ctm) : null;
    if (bb && stroke) {
      const scale = Math.sqrt(Math.abs(state.ctm[0] * state.ctm[3] - state.ctm[1] * state.ctm[2])) || 1;
      const pad = (Math.max(state.lineWidth, 0) * scale) / 2 + 0.01;
      bb = { minX: bb.minX - pad, minY: bb.minY - pad, maxX: bb.maxX + pad, maxY: bb.maxY + pad };
    }
    if (fill && !stroke && opts.vectors && contentVisible) {
      const rect = axisRect(data, state.ctm);
      if (rect) {
        // Opaque white under everything else is just the page background (the frame is already white).
        const nothingYet = body.length === 0 && elements.length === 0;
        if (nothingYet && state.fillAlpha >= 1 && /^(#fff(fff)?|white|rgb\(255,\s*255,\s*255\))$/i.test(fill)) return;
        // Hairline rules are drawn as thin filled rectangles: emit them as a stroked line.
        const w = rect.maxX - rect.minX, h = rect.maxY - rect.minY;
        const t = Math.min(w, h), len = Math.max(w, h);
        if (t > 0 && t <= 2.5 && len > 12 && len >= 6 * t) {
          const cx = (rect.minX + rect.maxX) / 2, cy = (rect.minY + rect.maxY) / 2;
          const line = w >= h ? `M${fmt(rect.minX)} ${fmt(cy)}H${fmt(rect.maxX)}` : `M${fmt(cx)} ${fmt(rect.minY)}V${fmt(rect.maxY)}`;
          const alpha = state.fillAlpha < 1 ? ` stroke-opacity="${fmt(state.fillAlpha)}"` : "";
          emit(`<path d="${line}" fill="none" stroke="${fill}" stroke-width="${fmt(t)}"${alpha}/>`, clipsFor(rect));
          return;
        }
      }
    }
    let attrs = ` d="${d}" transform="${matrixAttr(state.ctm)}"`;
    attrs += fill ? ` fill="${fill}"` : ` fill="none"`;
    if (fill && evenOdd) attrs += ` fill-rule="evenodd"`;
    if (fill && state.fillAlpha < 1) attrs += ` fill-opacity="${fmt(state.fillAlpha)}"`;
    if (stroke) attrs += strokeAttrs();
    const markup = `<path${attrs}/>`;
    if (fill && !stroke && bb && opts.vectors && contentVisible) {
      const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
      if (isBulletShaped(w, h)) {
        bullets.push({ cx: (bb.minX + bb.maxX) / 2, cy: (bb.minY + bb.maxY) / 2, width: w, height: h, markup, clips: clipsFor(bb), used: false });
        return;
      }
    }
    emit(markup, clipsFor(bb));
  };

  const applyPendingClip = (data: Float32Array | number[] | null) => {
    if (!pendingClip) return;
    const rule = pendingClip;
    pendingClip = null;
    if (!data || coversPage(data, state.ctm)) return;
    const d = pathToD(data);
    if (!d) return;
    const id = `c${++idCounter}`;
    const rect = axisRect(data, state.ctm);
    if (rect) rectClips.set(id, rect);
    defs.push(`<clipPath id="${id}"><path d="${d}" transform="${matrixAttr(state.ctm)}" clip-rule="${rule}"/></clipPath>`);
    state.clips = [...state.clips, id];
  };

  const clipRect = (x0: number, y0: number, x1: number, y1: number) => {
    const data = [D_MOVE, x0, y0, D_LINE, x1, y0, D_LINE, x1, y1, D_LINE, x0, y1, D_CLOSE];
    pendingClip = "nonzero";
    applyPendingClip(data);
  };

  const shadingFromIR = (ir: unknown): Shading | null => {
    if (!Array.isArray(ir)) return null;
    if (ir[0] === "RadialAxial") {
      return { type: ir[1], bbox: ir[2] ?? null, stops: ir[3], p0: ir[4], p1: ir[5], r0: ir[6], r1: ir[7] };
    }
    return null;
  };

  const gradientDef = (sh: Shading, transform: Matrix): string => {
    const id = `g${++idCounter}`;
    const stops = sh.stops
      .map(([o, c]) => `<stop offset="${fmt(o)}" stop-color="${esc(c)}"/>`)
      .join("");
    const gt = ` gradientUnits="userSpaceOnUse" gradientTransform="${matrixAttr(transform)}"`;
    if (sh.type === "axial") {
      defs.push(`<linearGradient id="${id}" x1="${fmt(sh.p0[0])}" y1="${fmt(sh.p0[1])}" x2="${fmt(sh.p1[0])}" y2="${fmt(sh.p1[1])}"${gt}>${stops}</linearGradient>`);
    } else {
      defs.push(`<radialGradient id="${id}" cx="${fmt(sh.p1[0])}" cy="${fmt(sh.p1[1])}" r="${fmt(sh.r1 ?? 0)}" fx="${fmt(sh.p0[0])}" fy="${fmt(sh.p0[1])}"${gt}>${stops}</radialGradient>`);
    }
    return `url(#${id})`;
  };

  const patternColor = (ir: unknown, target: "fill" | "stroke"): string | null => {
    if (!Array.isArray(ir)) return null;
    if (ir[0] === "Shading") {
      const sh = shadingFromIR(safeGet(ir[1]) ?? null);
      const matrix = (ir[2] as Matrix | null) ?? [1, 0, 0, 1, 0, 0];
      if (sh) return gradientDef(sh, mul(state.base, matrix));
      warnings.add("Mesh/function shadings approximated with grey");
      return "#9e9e9e";
    }
    if (ir[0] === "TilingPattern") {
      warnings.add("Tiling patterns approximated with grey");
      const color = ir[1];
      if (Array.isArray(color) && color.length === 3) {
        return `rgb(${color.map((v: number) => Math.round(v)).join(",")})`;
      }
      return target === "fill" ? "#bdbdbd" : "#9e9e9e";
    }
    return null;
  };

  const safeGet = (id: unknown): unknown => {
    if (typeof id !== "string") return id;
    try {
      return page.objs.has(id) ? page.objs.get(id) : page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
    } catch {
      return null;
    }
  };

  /** Images are delivered after the operator list resolves; wait for them (bounded). */
  const resolveObj = (id: unknown): Promise<unknown> => {
    if (typeof id !== "string") return Promise.resolve(id);
    const now = safeGet(id);
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 15000);
      try {
        page.objs.get(id, (data: unknown) => { if (!done) { done = true; clearTimeout(timer); resolve(data); } });
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  };

  const fillRgb255 = (): [number, number, number] => {
    const c = parseCssColor(state.fill) ?? BLACK;
    return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
  };

  let imageCount = 0;
  const placeImage = async (png: Uint8Array, ctm: Matrix, name: string) => {
    if (!opts.images || !contentVisible) return;
    const { transform, width, height } = unitSquareToPlacement(ctm);
    if (width < 0.01 || height < 0.01) return;
    flushSegment();
    imageCount++;
    elements.push({
      kind: "image",
      image: { png, transform, width, height, opacity: state.fillAlpha, name: `${name} ${imageCount}` },
    });
  };

  const paintImage = async (imgData: PdfImageData | null, ctm: Matrix) => {
    if (!imgData || !opts.images) return;
    try {
      await placeImage(await imageDataToPng(imgData), ctm, "Image");
    } catch (e) {
      warnings.add(`Image skipped: ${(e as Error).message}`);
    }
  };

  const paintMask = async (img: { data: unknown; width: number; height: number; bitmap?: ImageBitmap }, ctm: Matrix) => {
    if (!opts.images) return;
    try {
      const resolved = typeof img.data === "string" ? ((await resolveObj(img.data)) as PdfImageData | null) : null;
      const mask: PdfImageData = resolved
        ? resolved
        : { width: img.width, height: img.height, data: img.data as Uint8Array, bitmap: img.bitmap };
      await placeImage(await maskToPng(mask, fillRgb255()), ctm, "Mask");
    } catch (e) {
      warnings.add(`Image mask skipped: ${(e as Error).message}`);
    }
  };

  const textRun = (glyphs: unknown) => {
    if (!Array.isArray(glyphs)) return;
    let text = "";
    for (const g of glyphs) {
      if (g && typeof g === "object" && typeof (g as { unicode?: string }).unicode === "string") {
        text += (g as { unicode: string }).unicode;
      }
    }
    if (!text) return;
    const mode = state.textMode;
    const invisible = mode === 3 || mode === 7 || !contentVisible;
    const strokeOnly = mode === 1 || mode === 5;
    const css = strokeOnly ? state.stroke : state.fill;
    runs.push({
      text,
      color: parseCssColor(css) ?? BLACK,
      opacity: strokeOnly ? state.strokeAlpha : state.fillAlpha,
      visible: !invisible,
    });
  };

  const setGState = (states: unknown) => {
    if (!Array.isArray(states)) return;
    for (const entry of states) {
      if (!Array.isArray(entry)) continue;
      const [key, value] = entry;
      switch (key) {
        case "LW": state.lineWidth = value; break;
        case "LC": state.lineCap = value; break;
        case "LJ": state.lineJoin = value; break;
        case "D": state.dash = Array.isArray(value?.[0]) ? value[0] : null; break;
        case "CA": state.strokeAlpha = value; break;
        case "ca": state.fillAlpha = value; break;
        case "SMask": if (value) warnings.add("Soft masks are not supported"); break;
      }
    }
  };

  // --- main loop -----------------------------------------------------------
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = (argsArray[i] ?? []) as any[];
    switch (fn) {
      case OPS.save:
        stack.push({ ...state, clips: state.clips.slice() });
        break;
      case OPS.restore:
        if (stack.length) state = stack.pop()!;
        pendingClip = null;
        break;
      case OPS.transform:
        state.ctm = mul(state.ctm, args as unknown as Matrix);
        break;

      case OPS.setLineWidth: state.lineWidth = args[0]; break;
      case OPS.setLineCap: state.lineCap = args[0]; break;
      case OPS.setLineJoin: state.lineJoin = args[0]; break;
      case OPS.setDash: state.dash = Array.isArray(args[0]) ? args[0] : null; break;
      case OPS.setGState: setGState(args[0]); break;

      case OPS.setFillRGBColor: state.fill = typeof args[0] === "string" ? args[0] : null; break;
      case OPS.setStrokeRGBColor: state.stroke = typeof args[0] === "string" ? args[0] : null; break;
      case OPS.setFillTransparent: state.fill = null; break;
      case OPS.setStrokeTransparent: state.stroke = null; break;
      case OPS.setFillColorN: state.fill = patternColor(args, "fill"); break;
      case OPS.setStrokeColorN: state.stroke = patternColor(args, "stroke"); break;

      case OPS.clip: pendingClip = "nonzero"; break;
      case OPS.eoClip: pendingClip = "evenodd"; break;
      case OPS.endPath: pendingClip = null; break;

      case OPS.constructPath: {
        const op: number = args[0];
        const data: Float32Array | null = args[1]?.[0] ?? null;
        const d = pathToD(data);
        switch (op) {
          case OPS.fill: paintPath(d, true, false, false, data); break;
          case OPS.eoFill: paintPath(d, true, false, true, data); break;
          case OPS.stroke:
          case OPS.closeStroke: paintPath(d, false, true, false, data); break;
          case OPS.fillStroke:
          case OPS.closeFillStroke: paintPath(d, true, true, false, data); break;
          case OPS.eoFillStroke:
          case OPS.closeEOFillStroke: paintPath(d, true, true, true, data); break;
          case OPS.endPath: break;
        }
        applyPendingClip(data);
        break;
      }

      case OPS.shadingFill: {
        const sh = shadingFromIR(await resolveObj(args[0]));
        if (!sh) { warnings.add("Mesh shadings skipped"); break; }
        const paint = gradientDef(sh, state.ctm);
        if (sh.bbox) {
          const [x0, y0, x1, y1] = sh.bbox;
          emit(`<path d="M${fmt(x0)} ${fmt(y0)}H${fmt(x1)}V${fmt(y1)}H${fmt(x0)}Z" transform="${matrixAttr(state.ctm)}" fill="${paint}"${state.fillAlpha < 1 ? ` fill-opacity="${fmt(state.fillAlpha)}"` : ""}/>`);
        } else {
          emit(`<rect x="0" y="0" width="${fmt(pageWidth)}" height="${fmt(pageHeight)}" fill="${paint}"${state.fillAlpha < 1 ? ` fill-opacity="${fmt(state.fillAlpha)}"` : ""}/>`);
        }
        break;
      }

      case OPS.paintFormXObjectBegin: {
        stack.push({ ...state, clips: state.clips.slice() });
        const [matrix, bbox] = args;
        if (Array.isArray(matrix) && matrix.length === 6) state.ctm = mul(state.ctm, matrix as Matrix);
        state.base = state.ctm;
        if (Array.isArray(bbox) && bbox.length === 4) {
          clipRect(Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3]));
        }
        break;
      }
      case OPS.paintFormXObjectEnd:
        if (stack.length) state = stack.pop()!;
        break;

      case OPS.beginAnnotation: {
        stack.push({ ...state, clips: state.clips.slice() });
        const [, rect, transform, matrix] = args;
        state = { ...state, ctm: viewportTransform, base: viewportTransform, clips: [], fill: "#000000", stroke: "#000000", fillAlpha: 1, strokeAlpha: 1, lineWidth: 1, dash: null, lineCap: 0, lineJoin: 0 };
        if (Array.isArray(rect)) clipRect(rect[0], rect[1], rect[2], rect[3]);
        if (Array.isArray(transform)) state.ctm = mul(state.ctm, transform as Matrix);
        if (Array.isArray(matrix)) state.ctm = mul(state.ctm, matrix as Matrix);
        state.base = state.ctm;
        break;
      }
      case OPS.endAnnotation:
        if (stack.length) state = stack.pop()!;
        break;

      case OPS.paintImageXObject:
        await paintImage((await resolveObj(args[0])) as PdfImageData | null, state.ctm);
        break;
      case OPS.paintInlineImageXObject:
        await paintImage(args[0] as PdfImageData, state.ctm);
        break;
      case OPS.paintImageXObjectRepeat: {
        const img = (await resolveObj(args[0])) as PdfImageData | null;
        const [, sx, sy, positions] = args;
        for (let p = 0; p + 1 < positions.length; p += 2) {
          await paintImage(img, mul(state.ctm, [sx, 0, 0, sy, positions[p], positions[p + 1]]));
        }
        break;
      }
      case OPS.paintImageMaskXObject:
        await paintMask(args[0], state.ctm);
        break;
      case OPS.paintImageMaskXObjectRepeat: {
        const [img, sx, skx = 0, sky = 0, sy, positions] = args;
        for (let p = 0; p + 1 < positions.length; p += 2) {
          await paintMask(img, mul(state.ctm, [sx, skx, sky, sy, positions[p], positions[p + 1]]));
        }
        break;
      }
      case OPS.paintImageMaskXObjectGroup: {
        for (const img of args[0] ?? []) {
          await paintMask(img, mul(state.ctm, img.transform));
        }
        break;
      }
      case OPS.paintSolidColorImageMask:
        if (state.fill) {
          emit(`<rect x="0" y="0" width="1" height="1" transform="${matrixAttr(state.ctm)}" fill="${state.fill}"/>`);
        }
        break;
      case OPS.paintInlineImageXObjectGroup:
        warnings.add("Grouped inline images skipped");
        break;

      case OPS.setTextRenderingMode: state.textMode = args[0]; break;
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
        textRun(args[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        textRun(args[2]);
        break;

      case OPS.beginMarkedContentProps: {
        const [tag, props] = args;
        let visible = true;
        if (tag === "OC" && ocConfig && props) {
          try { visible = ocConfig.isVisible(props); } catch { visible = true; }
        }
        markedVisible.push(visible);
        contentVisible = markedVisible.every(Boolean);
        break;
      }
      case OPS.beginMarkedContent:
        markedVisible.push(true);
        break;
      case OPS.endMarkedContent:
        markedVisible.pop();
        contentVisible = markedVisible.every(Boolean);
        break;

      default:
        break;
    }
  }
  flushSegment();
  const defsMarkup = defs.length ? `<defs>${defs.join("")}</defs>` : "";
  const leftoverVector = (unused: BulletCandidate[]): ElementSpec | null => {
    if (!unused.length) return null;
    const parts: string[] = [];
    let open: string[] = [];
    for (const b of unused) {
      let common = 0;
      while (common < b.clips.length && common < open.length && b.clips[common] === open[common]) common++;
      for (let i = open.length; i > common; i--) parts.push("</g>");
      for (let i = common; i < b.clips.length; i++) parts.push(`<g clip-path="url(#${b.clips[i]})">`);
      open = b.clips.slice();
      parts.push(b.markup);
    }
    for (let i = open.length; i > 0; i--) parts.push("</g>");
    return { kind: "vector", vector: { svg: wrapSvg(defsMarkup, parts.join("")), name: "Small shapes" } };
  };
  return { elements, runs, warnings: [...warnings], bullets, leftoverVector };
}
