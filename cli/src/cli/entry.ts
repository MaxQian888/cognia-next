/**
 * Executable entry for the `cognia-agent` binary. Thin wrapper: parse + run +
 * map the exit code to the process. The shebang is added by the esbuild bundle
 * (see scripts/build-cli.mjs), not here, so the TS stays importable.
 */

// MUST be first: installs a synchronous IndexedDB on the global before any
// `@/lib` module (and the eager Dexie databases they construct at import) is
// evaluated. See ./db/install-indexeddb for the full rationale.
import "../db/install-indexeddb"
import { main } from "./index"

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`cognia-agent: fatal: ${err?.message ?? err}\n`)
    process.exitCode = 1
  })
