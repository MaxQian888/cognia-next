import assert from "node:assert/strict"
import test from "node:test"

import { buildCdpOnlyAppOpenArgs } from "./launch-config.ts"

test("CDP-only App launch preserves the normal bundled runtime", () => {
  const args = buildCdpOnlyAppOpenArgs({
    appPath: "/Applications/ChatGPT.app",
    cdpPort: 9229,
  })

  assert.deepEqual(args, [
    "--new",
    "/Applications/ChatGPT.app",
    "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9229",
  ])
  assert.equal(
    args.some((argument) => argument.includes("CODEX_CLI_PATH")),
    false
  )
  assert.equal(
    args.some((argument) => argument.includes("CODEX_APP_SERVER")),
    false
  )
})
