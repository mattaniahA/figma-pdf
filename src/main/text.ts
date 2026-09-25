import type { TextSpec } from "../shared/types";
import type { FontResolver } from "./fonts";

export async function createTextNode(spec: TextSpec, fonts: FontResolver, parent: FrameNode): Promise<TextNode | null> {
  const characters = spec.segments.map((s) => s.text).join("");
  if (!characters.trim()) return null;

  const resolved = spec.segments.map((s) => fonts.resolve({ name: s.fontName, bold: s.bold, italic: s.italic, weight: s.weight }));
  for (const r of resolved) await fonts.load(r.fontName);

  const node = figma.createText();
  node.fontName = resolved[0].fontName;
  node.characters = characters;
  node.textAutoResize = "WIDTH_AND_HEIGHT";
  node.textAlignVertical = "TOP";

  const glyphHeight = (spec.ascent - spec.descent) * spec.fontSize;
  const lineHeight = spec.lineHeight ?? Math.max(glyphHeight, spec.fontSize * 1.1);
  node.lineHeight = { unit: "PIXELS", value: lineHeight };
  node.letterSpacing = { unit: "PIXELS", value: spec.letterSpacing || 0 };
  node.paragraphSpacing = spec.paragraphSpacing || 0;

  let offset = 0;
  for (let i = 0; i < spec.segments.length; i++) {
    const seg = spec.segments[i];
    const end = offset + seg.text.length;
    if (end > offset) {
      node.setRangeFontName(offset, end, resolved[i].fontName);
      node.setRangeFontSize(offset, end, Math.max(1, seg.fontSize));
      node.setRangeFills(offset, end, [{ type: "SOLID", color: seg.color, opacity: seg.opacity }]);
    }
    offset = end;
  }

  applyList(node, spec, characters);

  parent.appendChild(node);
  node.name = (spec.list ? "List: " : "") + characters.split(/[\n\u2028]/)[0].slice(0, 40);
  fitWidth(node, spec, characters);

  // Position: Figma centres the glyph box inside the line-height box, so the
  // first baseline sits at top + (lineHeight - glyphHeight)/2 + ascent.
  const baselineFromTop = (lineHeight - glyphHeight) / 2 + spec.ascent * spec.fontSize;
  const rad = (spec.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const tlx = spec.x + baselineFromTop * sin;
  const tly = spec.y - baselineFromTop * cos;
  node.relativeTransform = [
    [cos, -sin, tlx],
    [sin, cos, tly],
  ];
  return node;
}

/** Native Figma list formatting per paragraph, so bullets/numbers stay editable (Enter adds an item). */
function applyList(node: TextNode, spec: TextSpec, characters: string) {
  if (!spec.list) return;
  const paras = characters.split("\n");
  if (!spec.listItems || spec.listItems.length !== paras.length) {
    node.setRangeListOptions(0, characters.length, { type: spec.list });
    return;
  }
  let start = 0;
  paras.forEach((p, i) => {
    const end = Math.min(characters.length, start + p.length + 1); // include the "\n"
    const item = spec.listItems![i];
    if (item && end > start) {
      node.setRangeListOptions(start, end, { type: item.type });
      // Figma list indentation is 1-based: 1 is a top-level item.
      if (item.level > 0) node.setRangeIndentation(start, end, item.level + 1);
    }
    start += p.length + 1;
  });
}

/**
 * Substitute fonts are often wider than the PDF's. Tighten tracking (and, as a
 * last resort, shrink the type a little) until the widest line matches the
 * width it had on the page, then give multi-line nodes a fixed box of that width.
 */
function fitWidth(node: TextNode, spec: TextSpec, characters: string) {
  const target = spec.width;
  if (!(target > 0)) return;
  const lines = characters.split(/[\n\u2028]/);
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const baseSpacing = spec.letterSpacing || 0;
  if (node.width > target * 1.02) {
    const excess = node.width - target;
    let tracking = -excess / Math.max(1, longest - 1);
    tracking = Math.max(tracking, -0.08 * spec.fontSize);
    node.letterSpacing = { unit: "PIXELS", value: baseSpacing + tracking };
  }
  if (node.width > target * 1.03) {
    const k = Math.max(0.9, target / node.width);
    let offset = 0;
    for (const seg of spec.segments) {
      const end = offset + seg.text.length;
      if (end > offset) node.setRangeFontSize(offset, end, Math.max(1, seg.fontSize * k));
      offset = end;
    }
  }
  if (spec.lineCount > 1) {
    node.textAutoResize = "HEIGHT";
    node.resize(Math.max(node.width, target) + 1, node.height);
  }
}
