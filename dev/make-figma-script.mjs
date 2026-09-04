// Usage: node dev/make-figma-script.mjs dev/out/synthetic.spec.json > dev/out/synthetic.figma.js
import * as esbuild from "esbuild";
import fs from "node:fs";
const [specPath] = process.argv.slice(2);
const pages = JSON.parse(fs.readFileSync(specPath, "utf8"));
const spec = { fileName: specPath.split("/").pop().replace(".spec.json", ""), pages };
const r = await esbuild.build({
  entryPoints: ["dev/figma-entry.ts"], bundle: true, write: false, format: "iife", globalName: "__pdfImport",
  target: "es2019", define: { __SPEC__: JSON.stringify(spec) },
});
process.stdout.write(r.outputFiles[0].text + "\nreturn __pdfImport.run();\n");
