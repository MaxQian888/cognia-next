import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

// `@` resolves to the cognia-next repo root so the viewer imports the real,
// already-tested share crypto (and, in Phase 4, the real A2UIRenderer) instead
// of a drifting copy.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": repoRoot },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
})
