import assert from "node:assert/strict"
import test from "node:test"

import {
  checkGeneratedTable,
  compareCommandSets,
  validateManifest,
} from "./check-companion-command-manifest.mjs"

function descriptor(overrides = {}) {
  return {
    name: "git_status",
    resource: "git",
    verb: "status",
    arm: "git_status",
    pagination: "none",
    longRunning: false,
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
  assert.deepEqual(validateManifest({ contractVersion: 3, commands: [descriptor()] }), [])
})

test("requires the grammar fields", () => {
  const errors = validateManifest({
    contractVersion: 3,
    commands: [descriptor({ resource: "", pagination: "cursor", longRunning: "no" })],
  })
  assert(errors.some((error) => error.includes("resource is required")))
  assert(errors.some((error) => error.includes("invalid pagination")))
  assert(errors.some((error) => error.includes("longRunning is required")))
})

test("rejects unclassified mutations and device-transportable service commands", () => {
  const errors = validateManifest({
    contractVersion: 3,
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

test("requires every remote descriptor to have a dispatch arm", () => {
  const manifest = {
    contractVersion: 3,
    commands: [descriptor(), descriptor({ name: "local_only", target: "client" })],
  }

  assert.deepEqual(
    compareCommandSets(manifest, new Set(["git_status", "local_only"]), new Set(["git_status"])),
    []
  )
  // A remote descriptor whose arm no dispatcher matches is the defect: every
  // catalog advertises it and dispatch 404s it. Extra registrations and extra
  // arms with no descriptor are unreachable, not errors.
  const errors = compareCommandSets(
    manifest,
    new Set(["local_only", "extra_registration"]),
    new Set(["extra_arm"])
  )
  assert(errors.some((error) => error.includes("remote command has no dispatch arm")))
  assert(errors.some((error) => error.includes("git_status")))
  assert(!errors.some((error) => error.includes("extra_registration")))
  assert(!errors.some((error) => error.includes("extra_arm")))
})

test("a remote descriptor needs a dispatch arm for its arm literal, not its name", () => {
  // After the ADR-0175 rename cut `name` is dotted and `arm` stays snake, so
  // the arm scan must key on `arm`. Until then the two are equal.
  const manifest = {
    contractVersion: 3,
    commands: [descriptor({ name: "git.status", arm: "git_status" })],
  }
  assert.deepEqual(compareCommandSets(manifest, new Set(), new Set(["git_status"])), [])
  const errors = compareCommandSets(manifest, new Set(), new Set(["git.status"]))
  assert(errors.some((error) => error.includes("remote command has no dispatch arm")))
  assert(errors.some((error) => error.includes("git.status")))
})

test("the generated Rust table must carry the manifest's contract version and row count", () => {
  const manifest = { contractVersion: 3, commands: [descriptor(), descriptor({ name: "git_log" })] }
  const table = (version, rows) =>
    `pub const CONTRACT_VERSION: u32 = ${version};\n` +
    Array.from({ length: rows }, (_, i) => `    WireCommand { name: "c${i}", arm: "c${i}" },`).join(
      "\n"
    )
  assert.deepEqual(checkGeneratedTable(manifest, table(3, 2)), [])
  assert(
    checkGeneratedTable(manifest, table(2, 2))[0].includes("CONTRACT_VERSION 2 lags manifest 3")
  )
  assert(checkGeneratedTable(manifest, table(3, 1))[0].includes("1 rows for 2 descriptors"))
  assert(checkGeneratedTable(manifest, "")[0].includes("missing CONTRACT_VERSION"))
})

test("rejects a descriptor whose handler was deleted", () => {
  // The regression: `record_cancel` outlived its Rust handler, so companions
  // kept discovering a command that could only ever fail to dispatch.
  const errors = compareCommandSets(
    {
      contractVersion: 3,
      commands: [descriptor({ name: "record_cancel", target: "client" })],
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
        contractVersion: 3,
        commands: [descriptor({ name: "plugin_computer_use_bash", target: "client" })],
      },
      new Set(),
      new Set()
    ),
    []
  )
})
