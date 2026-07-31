import { defineConfig } from "tsup"

// @cognia/plugin-ui is a standalone leaf: ZERO `@/` app imports, so a plugin
// author can `npm install` it and typecheck without a checkout of the app.
// react / radix-ui / lucide-react stay external because the host hands its own
// already-loaded instances to the plugin at require() time — bundling a second
// copy of React here is precisely the failure this package exists to prevent.
export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.test.ts", "!src/**/*.test.tsx"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["react", "react/jsx-runtime", "radix-ui", "lucide-react", "react-hook-form", "sonner"],
})
