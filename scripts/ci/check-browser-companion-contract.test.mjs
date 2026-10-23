import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { checkBrowserCompanionContract } from "./check-browser-companion-contract.mjs"

test("Host contract changes fail until an independently tested consumer snapshot is updated", async () => {
  const root = await mkdtemp(join(tmpdir(), "cognia-companion-contract-"))
  const product = join(root, "product"),
    extension = join(root, "extension")
  const put = async (base, name, content) => {
    const path = join(base, name)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, content)
  }
  try {
    for (const [host, browser, value] of [
      [
        "packages/companion-client/src/browser-agent-protocol.json",
        "vendor/companion-client/src/browser-agent-protocol.json",
        '{"agentProfile":"agent-safe-v1"}',
      ],
      [
        "packages/companion-client/src/session.ts",
        "vendor/companion-client/src/session.ts",
        "export const auth = 1",
      ],
      [
        "lib/browser/overlay.injected.js",
        "vendor/overlay/overlay.injected.js",
        "window.overlay = 1",
      ],
    ]) {
      await put(product, host, value)
      await put(extension, browser, value)
    }
    await put(
      product,
      "crates/cognia-companion/src/ws_browser_companion.rs",
      'const AGENT_PROFILE: &str = "agent-safe-v1";'
    )
    assert.equal(await checkBrowserCompanionContract(product, extension), 3)
    await put(product, "lib/browser/overlay.injected.js", "window.overlay = 2")
    await assert.rejects(checkBrowserCompanionContract(product, extension), /overlay.injected.js/)
    await put(extension, "vendor/overlay/overlay.injected.js", "window.overlay = 2")
    await put(product, "packages/companion-client/src/session.ts", "export const auth = 2")
    await assert.rejects(checkBrowserCompanionContract(product, extension), /session.ts/)
    await put(extension, "vendor/companion-client/src/session.ts", "export const auth = 2")
    await put(
      product,
      "crates/cognia-companion/src/ws_browser_companion.rs",
      'const AGENT_PROFILE: &str = "agent-v1";'
    )
    await assert.rejects(checkBrowserCompanionContract(product, extension), /safety profile/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
