import { defineConfig } from "tsup"

// @cognia/ocr is a standalone core: after extraction it has ZERO `@/` app
// imports. The Dexie cache, keyring credentials, platform detection and the
// Capacitor-backed native providers all stay app-side and reach the pipeline
// through `ExtractDeps`. Heavy engines (pdfjs, tesseract) and Tauri are loaded
// through guarded dynamic imports, so they stay external/optional.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2017",
  external: ["pdfjs-dist", "tesseract.js", /^@tauri-apps\//, /^@cognia\//],
})
