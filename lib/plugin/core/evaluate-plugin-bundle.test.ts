import { evaluatePluginBundle, PluginEvaluationError } from "./evaluate-plugin-bundle"
import { primeSharedModulesFor } from "./shared-modules"
import { definePlugin } from "@cognia/plugin-sdk"

test("evaluates bundled CommonJS with the host SDK instance", async () => {
  const code =
    'exports.definePlugin = require("@cognia/plugin-sdk").definePlugin; // trailing comment'
  await primeSharedModulesFor(code)
  expect(evaluatePluginBundle(code, "/plugin/index.js").definePlugin).toBe(definePlugin)
})

test("returns replaced module.exports and creates fresh module state each time", () => {
  const first = evaluatePluginBundle("module.exports = { count: 1 }", "/plugin/index.js")
  const second = evaluatePluginBundle("module.exports = { count: 2 }", "/plugin/index.js")
  expect(first).toEqual({ count: 1 })
  expect(second).toEqual({ count: 2 })
})

test("preserves evaluation errors for the loader transport fallback boundary", () => {
  expect(() =>
    evaluatePluginBundle('throw new Error("activation import failed")', "/broken.js")
  ).toThrow(PluginEvaluationError)
  expect(() => evaluatePluginBundle('require("@/stores/secret")', "/private.js")).toThrow(
    "host-private"
  )
})
