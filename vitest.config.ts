import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // The browser build of pdf.js needs DOM globals; tests only need OPS.
      "pdfjs-dist": path.resolve(__dirname, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"),
    },
  },
});
