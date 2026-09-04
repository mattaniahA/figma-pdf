/// <reference types="@figma/plugin-typings" />
import type { MainToUi, UiToMain } from "../shared/types";
import { applyRaster, beginSession, buildPage, finishSession, type Session } from "./build";

figma.showUI(__html__, { width: 360, height: 470, themeColors: true });

const send = (msg: MainToUi) => figma.ui.postMessage(msg);
let session: Session | null = null;

figma.ui.onmessage = async (msg: UiToMain) => {
  try {
    switch (msg.type) {
      case "begin":
        session = await beginSession(msg.fileName);
        session.onSvgFailed = (pageIndex, elementIndex, error) =>
          send({ type: "svg-failed", pageIndex, elementIndex, svg: "", error });
        break;
      case "page":
        if (!session) throw new Error("No import session");
        await buildPage(session, msg.page);
        send({ type: "page-done", pageIndex: msg.page.index });
        break;
      case "svg-raster":
        if (session) applyRaster(session, msg.pageIndex, msg.elementIndex, msg.png);
        break;
      case "done":
      case "cancel": {
        if (!session) break;
        finishSession(session);
        send({ type: "fonts", mapping: session.fonts.mapping });
        send({ type: "done", frameCount: session.frames.length });
        figma.notify(`Imported ${session.frames.length} page${session.frames.length === 1 ? "" : "s"} from ${session.fileName}`);
        session = null;
        break;
      }
      case "resize":
        figma.ui.resize(360, msg.height);
        break;
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    send({ type: "error", message });
    if (msg.type === "page") send({ type: "page-done", pageIndex: msg.page.index });
  }
};
