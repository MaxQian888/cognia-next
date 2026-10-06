import { defineConfig } from "tsup"
// static-export-exempt: Node-only declaration build config, never imported by runtime code.
import { fileURLToPath } from "node:url"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runtimeEntries } from "./tsup.config"

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// rollup-dts groups TS programs by entry directory. Stage tiny re-exports in
// one directory so every API shares one host type graph instead of allocating
// a separate multi-GB program for each original source directory.
const entryDirectory = mkdtempSync(join(tmpdir(), "cognia-sdk-declarations-"))
process.once("exit", () => rmSync(entryDirectory, { recursive: true, force: true }))
const entries = Object.fromEntries(
  Object.entries(runtimeEntries).map(([name, source]) => {
    const entry = join(entryDirectory, `${name}.ts`)
    writeFileSync(
      entry,
      `export * from ${JSON.stringify(local(`./${source}`).replace(/\.tsx?$/, ""))}\n`
    )
    return [name, entry]
  })
)
const declarationConfig = join(entryDirectory, "tsconfig.json")
writeFileSync(
  declarationConfig,
  JSON.stringify({
    extends: local("./tsconfig.json"),
    include: ["./*.ts", local("../../types/optional-modules.d.ts")],
  })
)

/** Generate each real public API, sharing flattened internal types between entries. */
export default defineConfig({
  entry: entries,
  tsconfig: declarationConfig,
  outDir: local("./dist"),
  target: "es2022",
  platform: "neutral",
  // Root cwd is CommonJS; tsup uses this mode to name declarations .d.ts.
  // Declaration syntax remains ESM and the published SDK has type: module.
  format: ["cjs"],
  noExternal: [/^@cognia\//],
  dts: { only: true, resolve: [/^@cognia\//], compilerOptions: { baseUrl: local("./") } },
  // The runtime build already cleaned dist; retain its JS/CJS outputs.
  clean: false,
})
