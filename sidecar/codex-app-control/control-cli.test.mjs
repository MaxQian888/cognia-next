import assert from "node:assert/strict"
import test from "node:test"

import { buildCodexTaskDeepLink } from "./cdp-bootstrap.mjs"

test("new App-owned tasks do not attach Browser context unless explicitly requested", () => {
  const plain = new URL(
    buildCodexTaskDeepLink({
      prompt: "hello",
      workspace: "/tmp",
      nonce: "plain-task",
    })
  )
  const browser = new URL(
    buildCodexTaskDeepLink({
      prompt: "inspect",
      browserUrl: "https://example.com",
      workspace: "/tmp",
      nonce: "browser-task",
    })
  )

  assert.equal(plain.searchParams.has("browserUrl"), false)
  assert.equal(browser.searchParams.get("browserUrl"), "https://example.com/")
})
