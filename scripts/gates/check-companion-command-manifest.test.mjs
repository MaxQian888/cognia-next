import assert from "node:assert/strict"
import test from "node:test"

import { compareCommandSets, validateManifest } from "./check-companion-command-manifest.mjs"

function descriptor(overrides = {}) {
  return {
    name: "git_status",
    since: 1,
    target: "execution",
    operation: "read",
    capability: "workspace.read",
    risk: "low",
    approval: "none",
    idempotency: "structural",
    transports: ["http"],
    inputSchema: "#/components/schemas/RpcArgs",
    outputSchema: "#/components/schemas/RpcResult",
    ...overrides,
  }
}

test("accepts a complete descriptor", () => {
  assert.deepEqual(validateManifest({ schemaVersion: 1, commands: [descriptor()] }), [])
})

test("rejects unclassified mutations and device-transportable service commands", () => {
  const errors = validateManifest({
    schemaVersion: 1,
    commands: [
      descriptor({
        name: "test_mcp_server",
        target: "service",
        operation: "side-effect",
        capability: "",
        idempotency: "structural",
        transports: ["http"],
      }),
    ],
  })

  assert(errors.some((error) => error.includes("capability is required")))
  assert(errors.some((error) => error.includes("mutations require idempotency")))
  assert(errors.some((error) => error.includes("service commands must be internal-only")))
})

test("requires every registration and v1 RPC to have the correct descriptor", () => {
  const manifest = {
    schemaVersion: 1,
    commands: [descriptor(), descriptor({ name: "local_only", since: 2, target: "client" })],
  }

  assert.deepEqual(
    compareCommandSets(manifest, new Set(["git_status", "local_only"]), new Set(["git_status"])),
    []
  )
  const errors = compareCommandSets(
    manifest,
    new Set(["git_status", "missing_local"]),
    new Set(["git_status", "missing_rpc"])
  )
  assert(errors.some((error) => error.includes("missing_local")))
  assert(errors.some((error) => error.includes("missing_rpc")))
})

test("rejects a descriptor whose handler was deleted", () => {
  // The regression: `record_cancel` outlived its Rust handler, so companions
  // kept discovering a command that could only ever fail to dispatch.
  const errors = compareCommandSets(
    {
      schemaVersion: 1,
      commands: [descriptor({ name: "record_cancel", since: 2, target: "client" })],
    },
    new Set(),
    new Set()
  )

  assert(errors.some((error) => error.includes("descriptor has no handler")))
  assert(errors.some((error) => error.includes("record_cancel")))
})

test("accepts plugin-dispatched descriptors with no static registration", () => {
  // `plugin_*` names come from a plugin's `executeIpc.invoke` at runtime, so
  // they are absent from both static sets by design.
  assert.deepEqual(
    compareCommandSets(
      {
        schemaVersion: 1,
        commands: [descriptor({ name: "plugin_computer_use_bash", since: 2, target: "client" })],
      },
      new Set(),
      new Set()
    ),
    []
  )
})
