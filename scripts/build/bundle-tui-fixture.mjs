// The PTY harness executes an esbuild artifact through the shipped CLI pipeline.
// Cache actual metafile inputs, including workspace packages, in immutable test
// generations. Editing an unrelated test must not rebuild the fixture.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cliEsbuildOptions, loadEsbuild } from "./esbuild-shared.mjs"
import { ensureTestBundle } from "./test-bundle-cache.mjs"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export async function ensureFixtureBundle({ root = projectRoot } = {}) {
  return ensureTestBundle({
    root,
    kind: "pty",
    entryName: "tui-app-fixture.mjs",
    key: "pty-fixture-v1",
    force: process.env.COGNIA_PTY_FIXTURE_REBUILD === "1",
    async build(outdir) {
      const esbuild = await loadEsbuild()
      const result = await esbuild.build({
        ...cliEsbuildOptions({
          root,
          entry: path.join(root, "cli/src/tui/pty/tui-app-fixture.tsx"),
          outdir,
          entryNames: "tui-app-fixture",
          banner: false,
        }),
        logLevel: "warning",
        metafile: true,
      })
      return {
        inputs: Object.keys(result.metafile.inputs).map((file) => path.resolve(file)),
        extraFiles: [
          fileURLToPath(import.meta.url),
          fileURLToPath(new URL("./esbuild-shared.mjs", import.meta.url)),
        ],
      }
    },
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await ensureFixtureBundle()}\n`)
}
