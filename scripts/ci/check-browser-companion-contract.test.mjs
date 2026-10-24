import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  checkBrowserCompanionContract,
  HOST_CONTRACT_INPUTS,
} from "./check-browser-companion-contract.mjs"

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "cognia-companion-contract-"))
  const product = join(root, "product"),
    extension = join(root, "extension")
  const put = async (base, name, content) => {
    const path = join(base, name)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, content)
  }
  const socket = 'const AGENT_PROFILE: &str = "agent-safe-v1"; redeem("/ws/browser-companion");'
  const snapshot = { schemaVersion: 1, sourceRevision: "0".repeat(40), files: {} }
  for (const name of HOST_CONTRACT_INPUTS) {
    const value = name.endsWith("/ws_browser_companion.rs") ? socket : `fixture for ${name}`
    await put(product, name, value)
    snapshot.files[name] = createHash("sha256").update(value).digest("hex")
  }
  const refresh = () => put(extension, "provenance/host-contract.json", JSON.stringify(snapshot))
  await refresh()
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
    ["lib/browser/overlay.injected.js", "vendor/overlay/overlay.injected.js", "window.overlay = 1"],
  ]) {
    await put(product, host, value)
    await put(extension, browser, value)
  }
  try {
    await run({ product, extension, put, socket, snapshot, refresh })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("shared client and executable overlay changes require a matching consumer refresh", async () => {
  await fixture(async ({ product, extension, put }) => {
    assert.equal(
      await checkBrowserCompanionContract(product, extension),
      3 + HOST_CONTRACT_INPUTS.length
    )
    await put(product, "lib/browser/overlay.injected.js", "window.overlay = 2")
    await assert.rejects(checkBrowserCompanionContract(product, extension), /overlay.injected.js/)
    await put(extension, "vendor/overlay/overlay.injected.js", "window.overlay = 2")
    await put(product, "packages/companion-client/src/session.ts", "export const auth = 2")
    await assert.rejects(checkBrowserCompanionContract(product, extension), /session.ts/)
  })
})

test("a removed Host input cannot silently shrink the checked client inventory", async () => {
  await fixture(async ({ product, extension }) => {
    await rm(join(product, "packages/companion-client/src/session.ts"))
    await assert.rejects(checkBrowserCompanionContract(product, extension), /inventory/)
  })
})

test("nested client runtime changes and consumer-only additions are checked", async () => {
  await fixture(async ({ product, extension, put }) => {
    await put(extension, "vendor/companion-client/src/nested/auth.ts", "export const auth = 1")
    await assert.rejects(checkBrowserCompanionContract(product, extension), /inventory/)
    await put(product, "packages/companion-client/src/nested/auth.ts", "export const auth = 2")
    await assert.rejects(checkBrowserCompanionContract(product, extension), /nested\/auth.ts/)
  })
})

test("same-profile socket ticket path changes cannot pass mock-Host consumer checks", async () => {
  await fixture(async ({ product, extension, put, socket }) => {
    await put(
      product,
      "crates/cognia-companion/src/ws_browser_companion.rs",
      socket.replace("/ws/browser-companion", "/ws/incompatible-v2")
    )
    await assert.rejects(
      checkBrowserCompanionContract(product, extension),
      /Host wire input drift.*ws_browser_companion/
    )
  })
})

test("empty Host snapshots and different safety profiles fail closed", async () => {
  await fixture(async ({ product, extension, put, socket, snapshot, refresh }) => {
    snapshot.files = {}
    await refresh()
    await assert.rejects(
      checkBrowserCompanionContract(product, extension),
      /Host wire input inventory/
    )
    await put(
      product,
      "crates/cognia-companion/src/ws_browser_companion.rs",
      socket.replace("agent-safe-v1", "agent-v1")
    )
    await assert.rejects(checkBrowserCompanionContract(product, extension), /safety profile/)
  })
})

test("origin helpers and new or removed Host implementation modules participate in the fence", async () => {
  await fixture(async ({ product, extension, put, snapshot, refresh }) => {
    const origin = "crates/cognia-companion/src/extension_origin.rs"
    const content = 'const EXTENSION_SCHEME: &str = "chrome-extension";'
    await put(product, origin, content)
    snapshot.files[origin] = createHash("sha256").update(content).digest("hex")
    await refresh()
    await checkBrowserCompanionContract(product, extension)
    await put(product, origin, content.replace("chrome-extension", "incompatible-v2"))
    await assert.rejects(
      checkBrowserCompanionContract(product, extension),
      /Host wire input drift.*extension_origin/
    )
    await rm(join(product, origin))
    await assert.rejects(
      checkBrowserCompanionContract(product, extension),
      /Host wire input inventory/
    )
  })
})

test("automatic and custom crate build scripts cannot bypass the Host source fence", async () => {
  await fixture(async ({ product, extension, put, snapshot, refresh }) => {
    const automatic = "crates/cognia-companion/build.rs"
    await put(product, automatic, "fn main() {}")
    await assert.rejects(
      checkBrowserCompanionContract(product, extension),
      /Host wire input inventory/
    )
    snapshot.files[automatic] = createHash("sha256").update("fn main() {}").digest("hex")
    await refresh()
    await checkBrowserCompanionContract(product, extension)
    await put(product, automatic, "fn main() { changed(); }")
    await assert.rejects(
      checkBrowserCompanionContract(product, extension),
      /Host wire input drift.*build.rs/
    )
    await rm(join(product, automatic))
    delete snapshot.files[automatic]
    await refresh()
    await put(product, "crates/cognia-companion/codegen/custom-build", "fn main() {}")
    await assert.rejects(
      checkBrowserCompanionContract(product, extension),
      /Host wire input inventory/
    )
  })
})
