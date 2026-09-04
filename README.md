# PDF to Frames — Figma plugin

Import a PDF into Figma as one frame per page with **editable** content:

- **Text** becomes real text layers: position, size, rotation, colour, mixed bold/italic runs, paragraphs with line height, detected letter-spacing.
- **Bulleted and numbered lists** become Figma lists. Bullet glyphs (`•`, `–`, `1.` …) and bullets drawn as tiny vector dots/dashes are removed and the items are merged into one text layer with list formatting, soft line breaks inside items, and paragraph spacing between items. PDF fonts are mapped to fonts installed on your machine (with an `Inter` fallback and a report of what was substituted).
- **Vector graphics** (lines, shapes, fills, strokes, dashes, clips, linear/radial gradients) become editable vector layers, imported via SVG.
- **Images** (including stencil masks) become image-filled rectangles placed with the exact PDF transform.
- Invisible OCR text layers and hidden optional-content layers are skipped.

All parsing happens locally in the plugin UI with [pdf.js](https://mozilla.github.io/pdf.js/); nothing leaves your machine (`networkAccess: none`). pdf.js runs on the UI thread (its worker module is bundled and registered as `globalThis.pdfjsWorker`) because Figma's sandboxed plugin iframe does not reliably start blob-URL Web Workers.

## Build

```bash
npm install
npm run build      # → dist/code.js + dist/ui.html (self-contained)
npm run watch      # rebuild on change
npm test           # unit tests (vitest)
npm run typecheck
```

## Install in Figma (development)

1. Open the Figma desktop app.
2. `Plugins → Development → Import plugin from manifest…` and choose `manifest.json` in this repo.
3. Run **PDF to Frames** from `Plugins → Development`.
4. Pick a PDF (or drop it on the panel), optionally set a page range, scale, and text mode, then click **Import**.

Text modes:

| Mode | Result |
| --- | --- |
| Paragraphs, keep line breaks | One text layer per paragraph, original line breaks preserved (exact layout) |
| Paragraphs, flowing text | One text layer per paragraph, lines joined with spaces (best for re-editing copy) |
| One layer per line | One text layer per line of text |

## How it works

```
UI iframe (pdf.js)                         Main thread (Figma API)
  getOperatorList  → SVG segments + images   createNodeFromSvg / createImage
  getTextContent   → lines → paragraphs      loadFontAsync + createText (+ range styles)
  colours per glyph from the draw ops        relativeTransform for exact placement
```

Key files:

- `src/ui/pdf/walkOps.ts` — walks the PDF operator list, keeps a graphics-state stack, emits SVG paths/clips/gradients, extracts images, records the fill colour of every text-drawing op.
- `src/ui/pdf/extractText.ts` — groups pdf.js text items into lines, paragraphs and lists (claiming bullet glyphs and tiny vector shapes next to a line), keeps styled runs, assigns colours.
- `src/main/fonts.ts` — maps PDF font names (`ABCDEF+Helvetica-BoldOblique`, `Calibri,Bold`, …) to available Figma fonts.
- `src/main/text.ts`, `src/main/build.ts` — create frames, images, vectors and text nodes.

## Dev harness

`dev/harness.html` emulates the Figma main thread in a browser so the conversion can be checked without Figma:

```bash
python3 -m http.server 8765            # serve the repo
node dev/run-harness.mjs samples/synthetic.pdf [keepBreaks|flow|lines]
# → dev/out/<name>.json (summary), <name>-pN.png (render), <name>.spec.json (full page spec)
node dev/make-figma-script.mjs dev/out/synthetic.spec.json > dev/out/synthetic.figma.js
node dev/dump.mjs dev/samples/synthetic.pdf      # text items vs. draw runs (debugging colours/grouping)
node dev/dump-ops.mjs dev/samples/synthetic.pdf  # raw operator list
```

The generated `*.figma.js` can be run inside Figma (for example through the Figma MCP `use_figma` tool) to exercise the node-building code without the plugin UI.

## Known limitations

- Text colour is matched to draw operations in order; unusual content streams can mis-colour a run.
- pdf.js occasionally inserts spaces into letter-spaced text (`R O T A T E D`).
- Mesh shadings, tiling patterns and soft masks are approximated (flat grey) or skipped, with a warning in the panel.
- Fonts not installed locally fall back to `Inter`; check the font report after import.
- Bullets are detected geometrically (a tiny shape or lone glyph just left of a line); unusual list layouts fall back to plain text plus a "Small shapes" vector layer for unclaimed dots.
- Very complex pages produce large SVGs; if Figma rejects one, it is rasterized to an image layer instead.
