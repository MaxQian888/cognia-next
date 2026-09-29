// Desktop local-mode entrypoint (ADR-0201). Protocol with the parent process:
//   stdin  line 1: {"secret","profilesRoot","overlayPath","browsersPath"?,"maxSessions"?,"maxPages"?}
//   stdout line 1: {"type":"ready","mode":"local","address":{address,family,port}}
//                  or {"type":"error","code","message"} followed by exit 78.
//   stdin EOF (parent died), SIGTERM or SIGINT: close every session's browser
//   first, then the control plane, and exit 0. If closing takes longer than
//   the grace period the process exits anyway (the desktop additionally kills
//   the runtime's whole process group, which takes any Chromium child with it).
import {
  errorLine,
  parseConfigLine,
  readConfigLine,
  readyLine,
  watchParentStdin,
} from "./local-config.mjs"
import { startLocalRuntime } from "./local-runtime.mjs"

const SHUTDOWN_GRACE_MS = 10_000

let config
try {
  config = parseConfigLine(await readConfigLine(process.stdin))
} catch (error) {
  process.stdout.write(errorLine(error))
  process.exit(78)
}

let runtime = null
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  // Never unref'd: this timer is what guarantees the exit when a browser
  // refuses to close.
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS)
  if (!runtime) {
    // Still starting: no browser session can exist before the ready line
    // (sessions are only created over the control plane), so exit at once.
    process.exit(0)
  }
  try {
    // `runtime.close()` closes every browser session before the listener.
    await runtime.close()
    process.exit(0)
  } catch {
    process.exit(1)
  }
}

// Watch for the parent going away from the moment the config line is read,
// so a parent that dies during startup never leaves an orphaned runtime.
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
watchParentStdin(process.stdin, () => void shutdown())

// Must be set before playwright-core loads: it resolves its browser registry
// directory from the environment at import time.
if (config.browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = config.browsersPath
const { chromium, devices } = await import("playwright-core")

try {
  runtime = await startLocalRuntime({ config, chromium, devices })
} catch (error) {
  process.stdout.write(errorLine(error))
  process.exit(78)
}

process.stdout.write(readyLine(runtime.address))
