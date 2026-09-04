import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";
const [file, pageNum = "1"] = process.argv.slice(2);
const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true }).promise;
const page = await pdf.getPage(+pageNum);
const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
const { fnArray, argsArray } = await page.getOperatorList();
for (let i = 0; i < fnArray.length; i++) {
  const a = argsArray[i];
  let s = names[fnArray[i]];
  if (fnArray[i] === pdfjs.OPS.paintImageXObject) s += ` ${a[0]} has=${page.objs.has(a[0])}`;
  else if (fnArray[i] === pdfjs.OPS.constructPath) s += ` op=${names[a[0]]} len=${a[1][0]?.length}`;
  else if (fnArray[i] === pdfjs.OPS.showText) s += ` "${a[0].map(g=>g?.unicode??'').join('')}"`;
  else if (a && a.length) s += " " + JSON.stringify(a).slice(0, 120);
  console.log(i, s);
}
