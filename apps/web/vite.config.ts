import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import type { Plugin } from "vite";

// index.html ships a strict CSP. The dev server injects inline scripts/styles (HMR,
// prefresh), so drop the CSP meta only under `vite serve`; build and preview keep it.
const devCsp = (): Plugin => ({
  name: "tribe-dev-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, ""),
});

export default defineConfig({
  base: "./",
  plugins: [preact(), devCsp()],
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 900 },
  esbuild: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
