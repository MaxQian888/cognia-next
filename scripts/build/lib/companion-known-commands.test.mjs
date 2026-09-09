import assert from "node:assert/strict"
import { test } from "node:test"

import {
  KNOWN_COMMANDS_RUST_PATH,
  remoteCommandNames,
  renderKnownCommandsRust,
} from "./companion-known-commands.mjs"

const HASH = "a".repeat(64)

function command(overrides = {}) {
  return {
    name: "session_list",
    resource: "session",
    verb: "list",
    arm: "session_list",
    target: "execution",
    operation: "read",
    capability: "sessions.read",
    risk: "low",
    approval: "none",
    idempotency: "structural",
    transports: ["http", "websocket", "webrtc"],
    pagination: "page-token",
    longRunning: false,
    inputSchema: "#/components/schemas/RpcArgs",
    outputSchema: "#/components/schemas/RpcResult",
    ...overrides,
  }
}

test("the remote set is every descriptor whose target is not client", () => {
  const manifest = {
    contractVersion: 3,
    commands: [
      command(),
      command({ name: "local_only", arm: "local_only", target: "client", transports: ["internal"] }),
      command({ name: "svc", arm: "svc", target: "service", transports: ["internal"] }),
      command({ name: "admin", arm: "admin", target: "host-admin" }),
    ],
  }
  assert.deepEqual([...remoteCommandNames(manifest)].sort(), ["admin", "session_list", "svc"])
})

test("renders one row per command with every enum mapped to its Rust variant", () => {
  const source = renderKnownCommandsRust({
    manifest: {
      contractVersion: 3,
      commands: [
        command(),
        command({
          name: "fs_read_chunk",
          resource: "fs",
          verb: "read_chunk",
          arm: "fs_read_chunk",
          target: "host-admin",
          operation: "side-effect",
          risk: "critical",
          approval: "signed-policy",
          idempotency: "required",
          transports: ["internal"],
          pagination: "byte-range",
          longRunning: true,
          inputSchema: 'x"y',
        }),
      ],
    },
    renames: { renames: { zeta_old: { to: "zeta.get" }, alpha_old: { to: "alpha.list", merge: "alpha.list" } } },
    catalogHash: HASH,
  })
  assert.match(source, /^pub const CONTRACT_VERSION: u32 = 3;$/m)
  assert.match(source, new RegExp(`^pub const CATALOG_HASH: &str = "${HASH}";$`, "m"))
  assert.match(
    source,
    /WireCommand \{ name: "session_list", arm: "session_list", resource: "session", verb: "list", target: CommandTarget::Execution, operation: CommandOperation::Read, capability: "sessions.read", risk: CommandRisk::Low, approval: CommandApproval::None, idempotency: CommandIdempotency::Structural, transports: &\[CommandTransport::Http, CommandTransport::Websocket, CommandTransport::Webrtc\], input_schema: "#\/components\/schemas\/RpcArgs", output_schema: "#\/components\/schemas\/RpcResult", pagination: CommandPagination::PageToken, long_running: false \},/
  )
  assert.match(
    source,
    /name: "fs_read_chunk".*target: CommandTarget::HostAdmin, operation: CommandOperation::SideEffect.*risk: CommandRisk::Critical, approval: CommandApproval::SignedPolicy, idempotency: CommandIdempotency::Required, transports: &\[CommandTransport::Internal\], input_schema: "x\\"y".*pagination: CommandPagination::ByteRange, long_running: true \},/
  )
  // Renames are sorted by the old name, and only the replacement is carried.
  const alpha = source.indexOf('("alpha_old", "alpha.list")')
  const zeta = source.indexOf('("zeta_old", "zeta.get")')
  assert.ok(alpha > 0 && zeta > alpha)
  assert.ok(!source.includes("merge"))
  assert.match(source, /#\[rustfmt::skip\]\npub static WIRE_COMMANDS/)
  // The file is mounted inside command_manifest.rs, so its imports are `super::`.
  assert.match(source, /^use super::\{$/m)
  assert.ok(!source.includes("super::super"))
  assert.ok(source.endsWith("];\n"))
})

test("refuses a contract it cannot map faithfully", () => {
  const base = { renames: { renames: {} }, catalogHash: HASH }
  assert.throws(
    () =>
      renderKnownCommandsRust({
        ...base,
        manifest: { contractVersion: 3, commands: [command({ target: "cloud" })] },
      }),
    /unknown target "cloud"/
  )
  assert.throws(
    () =>
      renderKnownCommandsRust({
        ...base,
        manifest: { contractVersion: 3, commands: [command(), command()] },
      }),
    /duplicate command descriptor: session_list/
  )
  assert.throws(
    () =>
      renderKnownCommandsRust({
        ...base,
        catalogHash: "nope",
        manifest: { contractVersion: 3, commands: [] },
      }),
    /sha256/
  )
  assert.throws(
    () =>
      renderKnownCommandsRust({
        ...base,
        manifest: { contractVersion: "3", commands: [] },
      }),
    /integer/
  )
})

test("the output path is where command_manifest looks", () => {
  assert.equal(KNOWN_COMMANDS_RUST_PATH, "src-tauri/src/companion_api/generated/known_commands.rs")
})
