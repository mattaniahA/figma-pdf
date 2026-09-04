// Bundled by dev/make-figma-script.mjs into a self-contained script that can be
// run inside Figma (e.g. via the Figma MCP `use_figma` tool) to exercise the
// main-thread node builder without the plugin UI.
import type { PageSpec } from "../src/shared/types";
import { beginSession, buildPage, finishSession } from "../src/main/build";

declare const __SPEC__: { fileName: string; pages: PageSpec[] };

export async function run() {
  const session = await beginSession(__SPEC__.fileName);
  const failures: string[] = [];
  session.onSvgFailed = (p, i, err) => failures.push(`page ${p} element ${i}: ${err}`);
  for (const page of __SPEC__.pages) {
    for (const el of page.elements) {
      if (el.kind === "image") el.image.png = figma.base64Decode(el.image.png as unknown as string);
    }
    await buildPage(session, page);
  }
  finishSession(session);
  return {
    frames: session.frames.map((f) => ({ id: f.id, name: f.name, width: f.width, height: f.height, children: f.children.length,
      texts: f.findAll((n) => n.type === "TEXT").length, vectors: f.findAll((n) => n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION").length })),
    fonts: session.fonts.mapping,
    failures,
  };
}
