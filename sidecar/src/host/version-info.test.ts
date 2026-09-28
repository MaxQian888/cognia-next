import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readVersionInfo } from "./version-info.ts"

test("source host resolves version metadata relative to the sidecar package", () => {
  const require = createRequire(import.meta.url)
  const info = readVersionInfo()
  assert.equal(info.sidecarVersion, require("../../package.json").version)
  // SDK releases that hide package.json keep the optional field absent.
  assert.ok(info.sdkVersion === undefined || typeof info.sdkVersion === "string")
})
