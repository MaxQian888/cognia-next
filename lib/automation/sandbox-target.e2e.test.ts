/**
 * Wiring test (ADR-0020 remote-target): the chat-path chain that turns a
 * session/character `computerUseTarget` into the `sandboxConnectionId` the Rust
 * `cua_route` layer reads. Exercises the pure resolver and the immutable runtime
 * reference the computer-use plugin receives, end-to-end.
 */
import { resolveComputerUseTarget } from "@/lib/automation/sandbox-target"
import { defaultSandboxCapabilities } from "@/lib/sandbox/connection-capabilities"
import { SandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import type { SandboxConnectionRow } from "@/types/sandbox"

const connection: SandboxConnectionRow = {
  id: "conn-9",
  name: "Remote desktop",
  provider: "docker",
  driver: "computer-server",
  config: {
    provider: "docker",
    image: "example/cua:latest",
    host: "127.0.0.1",
    port: 49152,
  },
  state: "running",
  capabilities: defaultSandboxCapabilities("docker", "computer-server"),
  lastHealthStatus: "ok",
  createdAt: 1,
  updatedAt: 1,
}

test("session remote target flows through resolve + runtime ref to the executor context", async () => {
  // resolveSendOptions resolves (session → character → local) at send time…
  const resolved = resolveComputerUseTarget({ connectionId: "conn-9" }, undefined)
  const runtime = new SandboxSessionRuntime({
    getConnection: jest.fn(async () => connection),
    getMicrovmAdapter: jest.fn(() => null),
    executeOsSandbox: jest.fn(),
    makeRef: jest.fn(() => "sandbox-runtime:remote"),
    recordAudit: jest.fn(async () => undefined),
  })
  const ref = await runtime.bindSession({
    sessionId: "sess-remote",
    binding: {
      shellTier: "os",
      computerTarget: resolved.kind === "remote" ? "bound" : "local",
      ...(resolved.kind === "remote" ? { connectionId: resolved.connectionId } : {}),
    },
    policy: null,
    confine: { writable: ["/workspace"], network: "off" },
    sandboxEnabled: true,
    computerUseEnabled: true,
    workspaceRoot: "/workspace",
  })

  // …and the plugin decorates the call from that ref, with no focused-session lookup.
  await expect(
    runtime.decorateComputerUseContext(ref, { surface: "computerUse" })
  ).resolves.toEqual({
    surface: "computerUse",
    sandboxConnectionId: "conn-9",
    sandboxConfine: { writable: ["/workspace"], network: "off" },
  })
})

test("session local override wins over a remote character default", () => {
  const resolved = resolveComputerUseTarget("local", { connectionId: "conn-char" })
  expect(resolved).toEqual({ kind: "local" })
})
