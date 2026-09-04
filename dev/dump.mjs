// Debug: print text items and showText runs for a page. Usage: node dev/dump.mjs file.pdf [page]
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";
const [file, pageNum = "1"] = process.argv.slice(2);
const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true }).promise;
const page = await pdf.getPage(+pageNum);
const { fnArray, argsArray } = await page.getOperatorList();
let fill = "#000";
console.log("--- runs (draw order)");
for (let i = 0; i < fnArray.length; i++) {
  const fn = fnArray[i], a = argsArray[i];
  if (fn === pdfjs.OPS.setFillRGBColor) fill = a[0];
  if (fn === pdfjs.OPS.showText || fn === pdfjs.OPS.nextLineShowText) console.log(fill, JSON.stringify(a[0].map(g => typeof g === "object" && g ? g.unicode : "").join("")));
  if (fn === pdfjs.OPS.nextLineSetSpacingShowText) console.log(fill, JSON.stringify(a[2].map(g => typeof g === "object" && g ? g.unicode : "").join("")));
}
console.log("--- items");
const tc = await page.getTextContent();
for (const it of tc.items) console.log(JSON.stringify(it.str), it.hasEOL ? "EOL" : "", it.transform?.map(v => +v.toFixed(1)).join(","), it.width?.toFixed(1), it.fontName);
