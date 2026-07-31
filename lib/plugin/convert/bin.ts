/**
 * Bundle entry for the converter.
 *
 * esbuild bundles this file into `crates/cognia-cli/assets/plugin-convert.mjs`,
 * which is `include_str!`-embedded in the `cognia` binary and written to a
 * temporary file at run time. Keeping the entry to one statement means the
 * only untested code in the chain is the process plumbing itself.
 */

import { runMain } from "./cli"
import { nodeIo } from "./node-io"

const { output, exitCode } = runMain(process.argv.slice(2), nodeIo)
process.stdout.write(output)
process.exitCode = exitCode
