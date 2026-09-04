export interface RGB {
  r: number; // 0..1
  g: number;
  b: number;
}

/** 2x3 affine matrix [a, b, c, d, e, f] in Figma (y-down) page coordinates. */
export type Matrix = [number, number, number, number, number, number];

export interface TextSegment {
  text: string;
  /** PostScript-ish font name from the PDF, e.g. "ABCDEF+Helvetica-Bold". */
  fontName: string;
  bold: boolean;
  italic: boolean;
  fontSize: number;
  color: RGB;
  opacity: number;
}

export interface TextSpec {
  /** Styled runs; concatenated they form the node's characters. */
  segments: TextSegment[];
  /** Baseline origin of the first line, in frame coordinates. */
  x: number;
  y: number;
  /** Rotation of the baseline in degrees, clockwise in y-down space. */
  angle: number;
  /** Width of the widest line along the baseline, in px. */
  width: number;
  /** Dominant font size. */
  fontSize: number;
  /** Extra tracking in px (0 when none detected). */
  letterSpacing: number;
  /** Baseline-to-baseline distance in px (null for a single line). */
  lineHeight: number | null;
  /** Extra space between paragraphs / list items in px. */
  paragraphSpacing: number;
  /** Font metrics from the PDF, as fractions of fontSize (descent is negative). */
  ascent: number;
  descent: number;
  lineCount: number;
  /** When set, paragraphs are list items (bullet glyphs/vectors were removed). */
  list: "UNORDERED" | "ORDERED" | null;
}

export interface ImageSpec {
  png: Uint8Array;
  /** Maps the image's top-left, unit x axis and unit y axis into frame coordinates. */
  transform: Matrix;
  width: number;
  height: number;
  opacity: number;
  name: string;
}

export interface VectorSpec {
  svg: string;
  name: string;
}

export type ElementSpec =
  | { kind: "vector"; vector: VectorSpec }
  | { kind: "image"; image: ImageSpec };

export interface PageSpec {
  index: number; // 1-based page number
  width: number;
  height: number;
  /** Bottom-to-top draw order of non-text content. */
  elements: ElementSpec[];
  texts: TextSpec[];
  warnings: string[];
}

export interface ImportOptions {
  scale: number;
  textMode: "lines" | "keepBreaks" | "flow";
  includeVectors: boolean;
  includeImages: boolean;
}

export type UiToMain =
  | { type: "begin"; fileName: string; pageCount: number; options: ImportOptions }
  | { type: "page"; page: PageSpec }
  | { type: "svg-raster"; pageIndex: number; elementIndex: number; png: Uint8Array }
  | { type: "done" }
  | { type: "cancel" }
  | { type: "resize"; height: number };

export type MainToUi =
  | { type: "ready" }
  | { type: "page-done"; pageIndex: number }
  | { type: "svg-failed"; pageIndex: number; elementIndex: number; svg: string; error: string }
  | { type: "fonts"; mapping: Record<string, string> }
  | { type: "done"; frameCount: number }
  | { type: "error"; message: string };
