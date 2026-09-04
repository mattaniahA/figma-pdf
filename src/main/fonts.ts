/** Maps PDF font names to fonts available in this Figma instance. */

export interface FontRequest {
  name: string;
  bold: boolean;
  italic: boolean;
}

interface Parsed {
  family: string; // normalized key
  weight: number; // 100..900
  italic: boolean;
}

const WEIGHTS: [RegExp, number][] = [
  [/\b(thin|hairline)\b/i, 100],
  [/\b(extra\s*light|ultra\s*light)\b/i, 200],
  [/\blight\b/i, 300],
  [/\b(regular|normal|roman|book|plain)\b/i, 400],
  [/\bmedium\b/i, 500],
  [/\b(semi\s*bold|demi\s*bold|demi)\b/i, 600],
  [/\b(extra\s*bold|ultra\s*bold)\b/i, 800],
  [/\b(black|heavy)\b/i, 900],
  [/\bbold\b/i, 700],
];

/** "HelveticaNeue-BoldItalic" → "Helvetica Neue Bold Italic" */
function splitCamel(s: string): string {
  return s
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_,+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const normalizeFamily = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function parseStyleWords(words: string): { weight: number | null; italic: boolean } {
  let weight: number | null = null;
  for (const [re, w] of WEIGHTS) {
    if (re.test(words)) { weight = w; break; }
  }
  const italic = /\b(italic|oblique|it|obl)\b/i.test(words);
  return { weight, italic };
}

export function parsePdfFontName(req: FontRequest): Parsed & { familyWords: string[] } {
  let name = req.name.replace(/^[A-Z]{6}\+/, ""); // subset tag
  name = name.replace(/(MT|PS|PSMT)$/g, "");
  const dash = name.search(/[-,]/);
  const familyRaw = dash >= 0 ? name.slice(0, dash) : name;
  const styleRaw = dash >= 0 ? name.slice(dash + 1) : "";
  const familyWordsAll = splitCamel(familyRaw).split(" ").filter(Boolean);
  const styleWords = splitCamel(styleRaw);

  const fromStyle = parseStyleWords(styleWords);
  // Weight words glued onto the family ("HelveticaNeueLight", "Arial Black")
  const familyStyle = parseStyleWords(familyWordsAll.join(" "));
  const familyWords = familyWordsAll.filter((w) => !parseStyleWords(w).weight && !parseStyleWords(w).italic);

  let weight = fromStyle.weight ?? familyStyle.weight ?? (req.bold ? 700 : 400);
  if (req.bold && weight < 600 && fromStyle.weight === null && familyStyle.weight === null) weight = 700;
  const italic = fromStyle.italic || familyStyle.italic || req.italic;
  return { family: normalizeFamily(familyWords.join("")), weight, italic, familyWords };
}

const ALIASES: Record<string, string[]> = {
  helvetica: ["Helvetica Neue", "Helvetica", "Arial", "Inter"],
  helveticaneue: ["Helvetica Neue", "Helvetica", "Arial", "Inter"],
  arial: ["Arial", "Helvetica Neue", "Helvetica", "Inter"],
  arialnarrow: ["Arial Narrow", "Arial", "Inter"],
  arialunicode: ["Arial Unicode MS", "Arial", "Inter"],
  times: ["Times New Roman", "Times", "Georgia"],
  timesnewroman: ["Times New Roman", "Times", "Georgia"],
  timesroman: ["Times New Roman", "Times", "Georgia"],
  courier: ["Courier New", "Courier", "Menlo", "Roboto Mono"],
  couriernew: ["Courier New", "Courier", "Menlo", "Roboto Mono"],
  symbol: ["Symbol", "Inter"],
  zapfdingbats: ["Zapf Dingbats", "Inter"],
  calibri: ["Calibri", "Carlito", "Inter"],
  cambria: ["Cambria", "Caladea", "Georgia"],
  segoeui: ["Segoe UI", "Inter"],
  sfpro: ["SF Pro", "SF Pro Text", "Inter"],
  sfprotext: ["SF Pro Text", "SF Pro", "Inter"],
  sfprodisplay: ["SF Pro Display", "SF Pro", "Inter"],
  verdana: ["Verdana", "Inter"],
  georgia: ["Georgia", "Times New Roman"],
  garamond: ["EB Garamond", "Garamond", "Georgia"],
  minionpro: ["Minion Pro", "Georgia"],
  myriadpro: ["Myriad Pro", "Inter"],
  robotomono: ["Roboto Mono", "Menlo", "Courier New"],
};

export interface Resolved {
  fontName: FontName;
  fallback: boolean;
}

export class FontResolver {
  private families = new Map<string, { family: string; styles: string[] }>();
  private cache = new Map<string, Resolved>();
  private loaded = new Set<string>();
  readonly mapping: Record<string, string> = {};

  async init() {
    const fonts = await figma.listAvailableFontsAsync();
    for (const f of fonts) {
      const key = normalizeFamily(f.fontName.family);
      let entry = this.families.get(key);
      if (!entry) this.families.set(key, (entry = { family: f.fontName.family, styles: [] }));
      entry.styles.push(f.fontName.style);
    }
  }

  private pickStyle(styles: string[], weight: number, italic: boolean): string {
    let best = styles[0];
    let bestScore = Infinity;
    for (const style of styles) {
      const p = parseStyleWords(style);
      const w = p.weight ?? 400;
      const condensed = /condensed|narrow|compressed|extended|expanded|display|caption|text|mono/i.test(style) ? 50 : 0;
      const score = Math.abs(w - weight) + (p.italic !== italic ? 250 : 0) + condensed;
      if (score < bestScore) { bestScore = score; best = style; }
    }
    return best;
  }

  resolve(req: FontRequest): Resolved {
    const key = `${req.name}|${req.bold}|${req.italic}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const parsed = parsePdfFontName(req);
    const candidates: string[] = [];
    if (parsed.family) candidates.push(parsed.family);
    // progressively drop trailing words ("Open Sans Semibold" → "Open Sans")
    for (let n = parsed.familyWords.length - 1; n >= 1; n--) candidates.push(normalizeFamily(parsed.familyWords.slice(0, n).join("")));
    for (const alias of Object.keys(ALIASES)) {
      if (parsed.family.startsWith(alias)) ALIASES[alias].forEach((f) => candidates.push(normalizeFamily(f)));
    }
    let entry: { family: string; styles: string[] } | undefined;
    let fallback = false;
    for (const c of candidates) {
      entry = this.families.get(c);
      if (entry) { fallback = c !== parsed.family && !(candidates.slice(0, parsed.familyWords.length).includes(c)); break; }
    }
    if (!entry) {
      entry = this.families.get("inter") ?? [...this.families.values()][0];
      fallback = true;
    }
    const style = this.pickStyle(entry.styles, parsed.weight, parsed.italic);
    const resolved: Resolved = { fontName: { family: entry.family, style }, fallback };
    this.cache.set(key, resolved);
    const label = req.name.replace(/^[A-Z]{6}\+/, "");
    this.mapping[label] = `${entry.family} ${style}${fallback ? " (fallback)" : ""}`;
    return resolved;
  }

  async load(font: FontName): Promise<void> {
    const key = `${font.family}|${font.style}`;
    if (this.loaded.has(key)) return;
    await figma.loadFontAsync(font);
    this.loaded.add(key);
  }
}
