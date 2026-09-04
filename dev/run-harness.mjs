// Usage: node dev/run-harness.mjs samples/synthetic.pdf [mode] [outdir]
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const [pdf = "samples/synthetic.pdf", mode = "keepBreaks", outdir = "dev/out"] = process.argv.slice(2);
fs.mkdirSync(outdir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 1000 });
page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 400)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:8765/dev/harness.html?pdf=${pdf}&mode=${mode}#dbg`);
try {
  await page.waitForFunction(() => window.__done === true, { timeout: 60000 });
} catch (e) {
  console.log("TIMEOUT; harness log:\n" + (await page.evaluate(() => document.getElementById("log").textContent)));
  await page.screenshot({ path: path.join(outdir, "timeout.png") });
  await browser.close();
  process.exit(1);
}
const summary = await page.evaluate(() =>
  window.__pages.map((p) => ({
    index: p.index, width: p.width, height: p.height, warnings: p.warnings,
    elements: p.elements.map((e) => e.kind === "vector" ? { kind: "vector", svgLen: e.vector.svg.length, paths: (e.vector.svg.match(/<path/g) || []).length } : { kind: "image", w: e.image.width, h: e.image.height, t: e.image.transform.map((v) => +v.toFixed(1)), png: e.image.png.length }),
    texts: p.texts.map((t) => ({ text: t.segments.map((s) => s.text).join(""), x: +t.x.toFixed(1), y: +t.y.toFixed(1), angle: +t.angle.toFixed(1), size: +t.fontSize.toFixed(1), lh: t.lineHeight && +t.lineHeight.toFixed(1), lines: t.lineCount, segs: t.segments.map((s) => `${s.fontName}${s.bold ? " B" : ""}${s.italic ? " I" : ""} #${[s.color.r, s.color.g, s.color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`) })),
  })),
);
const name = path.basename(pdf, ".pdf");
fs.writeFileSync(path.join(outdir, `${name}.json`), JSON.stringify(summary, null, 1));
const full = await page.evaluate(() => {
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  return window.__pages.map((p) => ({ ...p, elements: p.elements.map((e) => e.kind === "image" ? { kind: "image", image: { ...e.image, png: b64(e.image.png) } } : e) }));
});
fs.writeFileSync(path.join(outdir, `${name}.spec.json`), JSON.stringify(full));
const svgs = await page.evaluate(() => window.__pages.flatMap((p) => p.elements.filter((e) => e.kind === "vector").map((e) => e.vector.svg)));
svgs.forEach((s, i) => fs.writeFileSync(path.join(outdir, `${name}-${i}.svg`), s));
const pages = await page.$$(".page");
for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: path.join(outdir, `${name}-p${i + 1}.png`) });
console.log(await page.evaluate(() => document.getElementById("log").textContent));
await browser.close();
