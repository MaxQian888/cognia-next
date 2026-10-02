/**
 * Process entry for the bundle. Kept separate from `cli.ts` so tests can
 * import `main` without starting a process.
 */

import { main } from "./cli"

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
  // Timers are unref'd or cleared on shutdown; exit explicitly anyway so a
  // stray keep-alive socket cannot hold a stopped service open.
  setTimeout(() => process.exit(code), 100).unref()
})
