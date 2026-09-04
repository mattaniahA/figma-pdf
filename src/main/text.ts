import type { TextSpec } from "../shared/types";
import type { FontResolver } from "./fonts";

export async function createTextNode(spec: TextSpec, fonts: FontResolver, parent: FrameNode): Promise<TextNode | null> {
  const characters = spec.segments.map((s) => s.text).join("");
  if (!characters.trim()) return null;

  const resolved = spec.segments.map((s) => fonts.resolve({ name: s.fontName, bold: s.bold, italic: s.italic }));
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

  if (spec.list) node.setRangeListOptions(0, characters.length, { type: spec.list });

  parent.appendChild(node);
  node.name = (spec.list ? "List: " : "") + characters.split(/[\n\u2028]/)[0].slice(0, 40);

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
