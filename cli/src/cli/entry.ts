/**
 * Executable entry for the `cognia-agent` binary. Thin wrapper: parse + run +
 * map the exit code to the process. The shebang is added by the esbuild bundle
 * (see scripts/build-cli.mjs), not here, so the TS stays importable.
 */

import { main } from "./index"

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`cognia-agent: fatal: ${err?.message ?? err}\n`)
    process.exitCode = 1
  })
