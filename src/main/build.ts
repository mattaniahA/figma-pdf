import type { ImageSpec, PageSpec } from "../shared/types";
import { FontResolver } from "./fonts";
import { createTextNode } from "./text";

export interface Session {
  fileName: string;
  fonts: FontResolver;
  frames: FrameNode[];
  nextX: number;
  y: number;
  /** Rectangles standing in for SVGs Figma could not import, keyed "page:element". */
  placeholders: Map<string, RectangleNode>;
  onSvgFailed?: (pageIndex: number, elementIndex: number, error: string) => void;
}

function startPosition(): { x: number; y: number } {
  const nodes = figma.currentPage.children;
  if (!nodes.length) return { x: 0, y: 0 };
  let maxRight = -Infinity;
  let minTop = Infinity;
  for (const n of nodes) {
    maxRight = Math.max(maxRight, n.x + n.width);
    minTop = Math.min(minTop, n.y);
  }
  return { x: Math.ceil(maxRight + 100), y: Math.ceil(minTop) };
}

export async function beginSession(fileName: string): Promise<Session> {
  const fonts = new FontResolver();
  await fonts.init();
  const pos = startPosition();
  return { fileName, fonts, frames: [], nextX: pos.x, y: pos.y, placeholders: new Map() };
}

export function placeImage(spec: ImageSpec, parent: FrameNode): RectangleNode {
  const image = figma.createImage(spec.png);
  const rect = figma.createRectangle();
  rect.name = spec.name;
  rect.resize(Math.max(0.01, spec.width), Math.max(0.01, spec.height));
  rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  rect.opacity = spec.opacity;
  parent.appendChild(rect);
  const [a, b, c, d, e, f] = spec.transform;
  rect.relativeTransform = [
    [a, c, e],
    [b, d, f],
  ];
  return rect;
}

export async function buildPage(session: Session, page: PageSpec): Promise<FrameNode> {
  const frame = figma.createFrame();
  frame.name = `${session.fileName} – Page ${page.index}`;
  frame.resize(page.width, page.height);
  frame.x = session.nextX;
  frame.y = session.y;
  frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  frame.clipsContent = true;
  session.nextX += page.width + 100;
  session.frames.push(frame);

  page.elements.forEach((el, idx) => {
    if (el.kind === "image") {
      placeImage(el.image, frame);
      return;
    }
    try {
      const node = figma.createNodeFromSvg(el.vector.svg);
      node.name = el.vector.name;
      frame.appendChild(node);
      node.x = 0;
      node.y = 0;
    } catch (e) {
      const rect = figma.createRectangle();
      rect.name = `${el.vector.name} (rasterized)`;
      rect.resize(page.width, page.height);
      rect.fills = [];
      frame.appendChild(rect);
      session.placeholders.set(`${page.index}:${idx}`, rect);
      session.onSvgFailed?.(page.index, idx, (e as Error).message);
    }
  });

  for (const text of page.texts) {
    try {
      await createTextNode(text, session.fonts, frame);
    } catch (e) {
      console.warn("text failed", e, text);
    }
  }
  return frame;
}

export function applyRaster(session: Session, pageIndex: number, elementIndex: number, png: Uint8Array) {
  const rect = session.placeholders.get(`${pageIndex}:${elementIndex}`);
  if (!rect) return;
  const image = figma.createImage(png);
  rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
}

export function finishSession(session: Session) {
  if (session.frames.length) {
    figma.currentPage.selection = session.frames;
    figma.viewport.scrollAndZoomIntoView(session.frames);
  }
}
