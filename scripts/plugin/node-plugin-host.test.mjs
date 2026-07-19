import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  createRecordingContext,
  parseCallbackChain,
  resolvePluginDefinition,
} from "./node-plugin-host.mjs"

test("records context calls and assigns deterministic callback handles", () => {
  const recorder = createRecordingContext({ pluginId: "demo" })
  recorder.context.agent.registerTool({
    name: "echo",
    execute: async (value) => value,
  })

  assert.equal(recorder.calls[0].path, "agent.registerTool")
  assert.deepEqual(recorder.calls[0].args[0].execute, {
    $callback: "call.0.args.0.execute",
  })
  assert.equal(typeof recorder.callbacks.get("call.0.args.0.execute"), "function")
})

test("resolves ESM and transpiled CommonJS default definitions", () => {
  const definition = { activate() {} }
  assert.equal(resolvePluginDefinition({ default: definition }), definition)
  assert.equal(resolvePluginDefinition({ default: { default: definition } }), definition)
  assert.throws(() => resolvePluginDefinition({}), /activate/)
})

test("rejects unsafe callback-chain property paths", () => {
  const encoded = Buffer.from(
    JSON.stringify({ root: "exports.factory", rootArgs: [], steps: [], path: ["__proto__"] })
  ).toString("base64url")
  assert.throws(() => parseCallbackChain(`chain:${encoded}`), /Unsafe/)
  assert.throws(() => parseCallbackChain(`chain:${"a".repeat(96 * 1024 + 1)}`), /Invalid/)
})

test("a real Node subprocess invokes registered and named-export callbacks", () => {
  const directory = mkdtempSync(join(tmpdir(), "cognia-node-plugin-host-"))
  const entry = join(directory, "plugin.mjs")
  writeFileSync(
    entry,
    `export async function createConnector(config) {
      return {
        id: config.id,
        connected: true,
        connect: async () => ({ status: "connected" })
      }
    }
    export default {
      manifest: { id: "demo" },
      activate(ctx) {
        ctx.agent.registerTool({
          name: "echo",
          execute: async (args) => ({ echoed: args.message })
        })
        return { onCommand: async (command) => command === "hello" }
      }
    }`
  )
  const source = readFileSync(new URL("./node-plugin-host.mjs", import.meta.url), "utf8")
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      "callback",
      entry,
      "demo",
      "call.0.args.0.execute",
      '[{"message":"hi"}]',
    ],
    { encoding: "utf8" }
  )

  const frame = JSON.parse(stdout.trim().replace(/^COGNIA_PLUGIN_RESULT:/, ""))
  assert.deepEqual(frame.result, { echoed: "hi" })

  const exportStdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      "callback",
      entry,
      "demo",
      "exports.createConnector",
      '[{"id":"mail"}]',
    ],
    { encoding: "utf8" }
  )
  const exportFrame = JSON.parse(exportStdout.trim().replace(/^COGNIA_PLUGIN_RESULT:/, ""))
  assert.equal(exportFrame.result.id, "mail")
  assert.equal(exportFrame.result.connected, true)
  assert.match(exportFrame.result.connect.$callback, /^chain:/)

  const nestedStdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      "callback",
      entry,
      "demo",
      exportFrame.result.connect.$callback,
      "[]",
    ],
    { encoding: "utf8" }
  )
  const nestedFrame = JSON.parse(nestedStdout.trim().replace(/^COGNIA_PLUGIN_RESULT:/, ""))
  assert.deepEqual(nestedFrame.result, { status: "connected" })
})

test("a real Node subprocess activates a CommonJS SDK bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "cognia-node-plugin-host-cjs-"))
  const entry = join(directory, "plugin.cjs")
  writeFileSync(
    entry,
    `module.exports = {
      manifest: { id: "cjs-demo" },
      activate(ctx) {
        ctx.agent.registerTool({ name: "cjs_echo", execute: async (value) => value })
      }
    }`
  )
  const source = readFileSync(new URL("./node-plugin-host.mjs", import.meta.url), "utf8")
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      "callback",
      entry,
      "cjs-demo",
      "call.0.args.0.execute",
      '[{"message":"cjs"}]',
    ],
    { encoding: "utf8" }
  )
  const frame = JSON.parse(stdout.trim().replace(/^COGNIA_PLUGIN_RESULT:/, ""))
  assert.deepEqual(frame.result, { message: "cjs" })
})
