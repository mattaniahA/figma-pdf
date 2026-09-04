import type { Matrix } from "../../shared/types";

/** Shapes pdf.js hands back from `page.objs.get(id)` for images. */
export interface PdfImageData {
  width: number;
  height: number;
  kind?: number; // 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  data?: Uint8Array | Uint8ClampedArray;
  bitmap?: ImageBitmap;
  interpolate?: boolean;
}

function makeCanvas(w: number, h: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext("2d")! };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d")! };
}

async function canvasToPng(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  const blob: Blob = await ("convertToBlob" in canvas
    ? canvas.convertToBlob({ type: "image/png" })
    : new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
      ));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Convert a decoded pdf.js image into RGBA bytes on a canvas and export PNG. */
export async function imageDataToPng(img: PdfImageData): Promise<Uint8Array> {
  const { width, height } = img;
  const { canvas, ctx } = makeCanvas(width, height);
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return canvasToPng(canvas);
  }
  const src = img.data;
  if (!src) throw new Error("image has no pixel data");
  const out = ctx.createImageData(width, height);
  const dest = out.data;
  if (img.kind === 1) {
    // 1 bit per pixel, rows padded to a byte boundary; bit set = white.
    const rowBytes = (width + 7) >> 3;
    let k = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = src[y * rowBytes + (x >> 3)] & (128 >> (x & 7));
        const v = bit ? 255 : 0;
        dest[k++] = v; dest[k++] = v; dest[k++] = v; dest[k++] = 255;
      }
    }
  } else if (img.kind === 2) {
    for (let i = 0, k = 0; i < width * height; i++) {
      dest[k++] = src[i * 3]; dest[k++] = src[i * 3 + 1]; dest[k++] = src[i * 3 + 2]; dest[k++] = 255;
    }
  } else {
    dest.set(src.subarray(0, width * height * 4));
  }
  ctx.putImageData(out, 0, 0);
  return canvasToPng(canvas);
}

/**
 * Stencil mask: packed 1bpp, bit 0 = paint with `fill`, bit 1 = transparent
 * (pdf.js decodes /Decode into the bits already).
 */
export async function maskToPng(
  img: PdfImageData,
  fill: [number, number, number],
): Promise<Uint8Array> {
  const { width, height } = img;
  const { canvas, ctx } = makeCanvas(width, height);
  if (img.bitmap) {
    // pdf.js already produced a coloured bitmap for this mask.
    ctx.drawImage(img.bitmap, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = `rgb(${fill[0]},${fill[1]},${fill[2]})`;
    ctx.fillRect(0, 0, width, height);
    return canvasToPng(canvas);
  }
  const src = img.data!;
  const out = ctx.createImageData(width, height);
  const dest = out.data;
  const rowBytes = (width + 7) >> 3;
  let k = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = src[y * rowBytes + (x >> 3)] & (128 >> (x & 7));
      dest[k++] = fill[0]; dest[k++] = fill[1]; dest[k++] = fill[2]; dest[k++] = bit ? 0 : 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvasToPng(canvas);
}

/**
 * PDF images occupy the unit square in user space with the image's top edge
 * at y=1. Given the CTM (already mapped into y-down page space) return the
 * Figma-style transform whose origin is the image's top-left corner and whose
 * axes are unit-length, plus the drawn size.
 */
export function unitSquareToPlacement(ctm: Matrix): { transform: Matrix; width: number; height: number } {
  const [a, b, c, d, e, f] = ctm;
  // top-left corner = ctm · (0, 1)
  const tlx = c + e;
  const tly = d + f;
  const width = Math.hypot(a, b);
  const height = Math.hypot(c, d);
  // x axis: (1,0) direction; y-down axis: from top (0,1) to bottom (0,0) = -(c,d)
  const ux = width ? [a / width, b / width] : [1, 0];
  const uy = height ? [-c / height, -d / height] : [0, 1];
  return { transform: [ux[0], ux[1], uy[0], uy[1], tlx, tly], width, height };
}
