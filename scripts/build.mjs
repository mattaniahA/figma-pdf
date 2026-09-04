import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });


const inlineUiPlugin = {
  name: "inline-ui",
  setup(build) {
    build.onEnd((result) => {
      const js = result.outputFiles?.find((f) => f.path.endsWith(".js"));
      if (!js) return;
      const html = fs.readFileSync(path.join(root, "src/ui/ui.html"), "utf8");
      // </script> inside the bundle must not terminate the inline script tag.
      // `<!--` inside a classic inline script starts an HTML-like comment, so escape it too.
      const safe = js.text.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
      fs.writeFileSync(
        path.join(dist, "ui.html"),
        html.replace("<!--BUNDLE-->", () => `<script>${safe}</script>`),
      );
      console.log(`[ui] dist/ui.html ${(safe.length / 1024 / 1024).toFixed(2)} MB`);
    });
  },
};

const mainOpts = {
  entryPoints: [path.join(root, "src/main/code.ts")],
  bundle: true,
  format: "iife",
  target: "es2019",
  outfile: path.join(dist, "code.js"),
  logLevel: "info",
};

const uiOpts = {
  entryPoints: [path.join(root, "src/ui/ui.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  write: false,
  outdir: dist,
  minify: !watch,
  plugins: [inlineUiPlugin],
  logLevel: "info",
};

if (watch) {
  const [m, u] = await Promise.all([esbuild.context(mainOpts), esbuild.context(uiOpts)]);
  await Promise.all([m.watch(), u.watch()]);
  console.log("watching…");
} else {
  await Promise.all([esbuild.build(mainOpts), esbuild.build(uiOpts)]);
}
