import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ImportOptions, MainToUi, Matrix, PageSpec, UiToMain } from "../shared/types";
import { loadPdf } from "./pdf/loadPdf";
import { walkOps } from "./pdf/walkOps";
import { extractTexts, type FontInfo } from "./pdf/extractText";
import { estimateType3Weights } from "./pdf/fontWeight";
import { rasterizeSvg } from "./pdf/rasterizeSvg";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>("file");
const drop = $<HTMLElement>("drop");
const runBtn = $<HTMLButtonElement>("run");
const cancelBtn = $<HTMLButtonElement>("cancel");
const progress = $<HTMLProgressElement>("progress");
const status = $<HTMLElement>("status");
const log = $<HTMLElement>("log");

let file: File | null = null;
let cancelled = false;
let running = false;
const pageDoneWaiters = new Map<number, () => void>();
const svgByKey = new Map<string, { svg: string; width: number; height: number }>();

const post = (msg: UiToMain, transfer?: Transferable[]) =>
  parent.postMessage({ pluginMessage: msg }, "*");

function setStatus(text: string, cls = "muted") {
  status.className = cls;
  status.textContent = text;
}
function addLog(text: string, cls = "") {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function pickFile(f: File | undefined) {
  if (!f) return;
  file = f;
  $("fileLabel").textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
  runBtn.disabled = false;
  log.textContent = "";
  setStatus("");
}
fileInput.addEventListener("change", () => pickFile(fileInput.files?.[0]));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  pickFile(e.dataTransfer?.files?.[0]);
});

function parseRange(input: string, count: number): number[] {
  const s = input.trim();
  if (!s) return Array.from({ length: count }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of s.split(/[,\s]+/)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Math.max(1, +m[1]);
    const b = Math.min(count, m[2] ? +m[2] : a);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

function readOptions(): ImportOptions {
  return {
    scale: Math.min(4, Math.max(0.25, +$<HTMLInputElement>("scale").value || 1)),
    textMode: $<HTMLSelectElement>("textMode").value as ImportOptions["textMode"],
    includeVectors: $<HTMLInputElement>("vectors").checked,
    includeImages: $<HTMLInputElement>("images").checked,
  };
}

async function fontInfos(pdfPage: import("pdfjs-dist").PDFPageProxy, textContent: import("pdfjs-dist/types/src/display/api").TextContent): Promise<Map<string, FontInfo>> {
  const map = new Map<string, FontInfo>();
  const styles = textContent.styles as Record<string, any>;
  const chars = new Map<string, number>();
  for (const item of textContent.items) {
    if ("str" in item) chars.set(item.fontName, (chars.get(item.fontName) ?? 0) + item.str.length);
  }
  const fonts = new Map<string, any>();
  for (const loadedName of Object.keys(styles)) {
    try {
      fonts.set(loadedName, pdfPage.commonObjs.has(loadedName) ? pdfPage.commonObjs.get(loadedName) : null);
    } catch { /* not resolved */ }
  }
  const weights = estimateType3Weights([...fonts].map(([key, font]) => ({ key, font, chars: chars.get(key) ?? 0 })));
  for (const [loadedName, style] of Object.entries(styles)) {
    const font = fonts.get(loadedName) ?? null;
    const weight = weights.get(loadedName);
    map.set(loadedName, {
      name: font?.name ?? style.fontFamily ?? loadedName,
      weight,
      bold: weight !== undefined ? weight >= 600 : !!font?.bold || !!font?.black,
      italic: !!font?.italic,
      ascent: typeof style.ascent === "number" && style.ascent > 0 ? style.ascent : 0.9,
      descent: typeof style.descent === "number" && style.descent < 0 ? style.descent : -0.22,
    });
  }
  return map;
}

async function convertPage(pdf: PDFDocumentProxy, num: number, options: ImportOptions): Promise<PageSpec> {
  const page = await pdf.getPage(num);
  const viewport = page.getViewport({ scale: options.scale });
  const vt = viewport.transform as Matrix;
  const ocConfig = await pdf.getOptionalContentConfig();
  const walk = await walkOps(page, vt, viewport.width, viewport.height, ocConfig, {
    vectors: options.includeVectors,
    images: options.includeImages,
  });
  const textContent = await page.getTextContent();
  const fonts = await fontInfos(page, textContent);
  const texts = extractTexts(textContent, vt, fonts, walk.runs, options.textMode, walk.bullets);
  const elements = walk.elements.slice();
  const leftover = walk.leftoverVector(walk.bullets.filter((b) => !b.used));
  if (leftover) elements.push(leftover);
  page.cleanup();
  return { index: num, width: viewport.width, height: viewport.height, elements, texts, warnings: walk.warnings };
}

async function run() {
  if (!file || running) return;
  running = true;
  cancelled = false;
  runBtn.disabled = true;
  cancelBtn.hidden = false;
  progress.hidden = false;
  progress.value = 0;
  log.textContent = "";
  svgByKey.clear();
  const options = readOptions();
  try {
    setStatus("Reading PDF…");
    const pdf = await loadPdf(await file.arrayBuffer());
    const pages = parseRange($<HTMLInputElement>("pages").value, pdf.numPages);
    if (!pages.length) throw new Error("No pages selected");
    post({ type: "begin", fileName: file.name.replace(/\.pdf$/i, ""), pageCount: pages.length, options });
    const allWarnings = new Set<string>();
    for (let i = 0; i < pages.length; i++) {
      if (cancelled) break;
      setStatus(`Converting page ${pages[i]} (${i + 1}/${pages.length})…`);
      const spec = await convertPage(pdf, pages[i], options);
      spec.warnings.forEach((w) => allWarnings.add(w));
      spec.elements.forEach((el, idx) => {
        if (el.kind === "vector") svgByKey.set(`${spec.index}:${idx}`, { svg: el.vector.svg, width: spec.width, height: spec.height });
      });
      const done = new Promise<void>((res) => pageDoneWaiters.set(spec.index, res));
      post({ type: "page", page: spec });
      setStatus(`Building page ${pages[i]} in Figma (${i + 1}/${pages.length})…`);
      await done;
      progress.value = (i + 1) / pages.length;
      addLog(`Page ${pages[i]}: ${spec.texts.length} text layers, ${spec.elements.length} graphics`);
    }
    allWarnings.forEach((w) => addLog(w, "warn"));
    post({ type: cancelled ? "cancel" : "done" });
    await pdf.destroy();
  } catch (e) {
    console.error(e);
    setStatus(`Failed: ${(e as Error).message}`, "err");
    post({ type: "cancel" });
  } finally {
    running = false;
    runBtn.disabled = false;
    cancelBtn.hidden = true;
  }
}
runBtn.addEventListener("click", run);
cancelBtn.addEventListener("click", () => { cancelled = true; setStatus("Cancelling…"); });

window.onmessage = async (e: MessageEvent) => {
  const msg = e.data?.pluginMessage as MainToUi | undefined;
  if (!msg) return;
  switch (msg.type) {
    case "page-done":
      pageDoneWaiters.get(msg.pageIndex)?.();
      pageDoneWaiters.delete(msg.pageIndex);
      break;
    case "svg-failed": {
      const entry = svgByKey.get(`${msg.pageIndex}:${msg.elementIndex}`);
      addLog(`Page ${msg.pageIndex}: vector import failed (${msg.error}); rasterizing instead`, "warn");
      if (!entry) break;
      try {
        const png = await rasterizeSvg(entry.svg, entry.width, entry.height);
        post({ type: "svg-raster", pageIndex: msg.pageIndex, elementIndex: msg.elementIndex, png });
      } catch (err) {
        addLog(`Rasterization failed: ${(err as Error).message}`, "err");
      }
      break;
    }
    case "fonts": {
      const entries = Object.entries(msg.mapping);
      if (entries.length) {
        addLog("Fonts:");
        for (const [pdfFont, figmaFont] of entries) addLog(`  ${pdfFont} → ${figmaFont}`, figmaFont.includes("(fallback)") ? "warn" : "");
      }
      break;
    }
    case "done":
      setStatus(`Done: ${msg.frameCount} frame${msg.frameCount === 1 ? "" : "s"} created.`);
      break;
    case "error":
      setStatus(msg.message, "err");
      addLog(msg.message, "err");
      break;
    default: {
      // Dev harness only: {type:"dev-file", name, data} feeds a PDF without a file picker.
      const dev = msg as unknown as { type: string; name: string; data: ArrayBuffer; options?: Partial<ImportOptions> };
      if (dev.type === "dev-file") {
        if (dev.options?.textMode) $<HTMLSelectElement>("textMode").value = dev.options.textMode;
        pickFile(new File([dev.data], dev.name, { type: "application/pdf" }));
        run();
      }
    }
  }
};
