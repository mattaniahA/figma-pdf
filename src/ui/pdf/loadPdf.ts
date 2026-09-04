import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
// Bundling the worker module registers `globalThis.pdfjsWorker`, which makes
// pdf.js parse on the main thread. Figma's plugin iframe cannot start Web
// Workers from blob URLs reliably, so this is the dependable option.
import "pdfjs-dist/build/pdf.worker.min.mjs";

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    data,
    disableFontFace: true, // we never draw text with pdf.js; fonts are mapped to Figma fonts
    fontExtraProperties: true,
  });
  return task.promise;
}

export { pdfjs };
