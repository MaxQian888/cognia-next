import type { ResolvedConfig } from "../config/schema"
import { buildWorkerManifest, loadWorkerDeviceConfig, workerSocketUrl } from "./worker-connect"

const config = {
  providers: {
    openai: { apiKey: "secret" },
    anthropic: {},
  },
  model: "gpt-test",
  agentBackend: "builtin",
} as unknown as ResolvedConfig

describe("worker connect contract", () => {
  it("builds an opaque readiness manifest without credential values or local paths", () => {
    const manifest = buildWorkerManifest(config, ["repository:project:repo"], 2)
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      runtime: "builtin",
      models: ["gpt-test"],
      maxActiveTurns: 2,
      credentialProfileRefs: ["credential:openai"],
      workspaceBindingRefs: ["repository:project:repo"],
      taskWorkspace: { enabled: true },
    })
    expect(manifest.hardCapabilities).toEqual(
      expect.arrayContaining(["streaming", "session.multi-turn", "worker-dispatch-v1"])
    )
    expect(manifest.sandbox.capabilities).toContain("filesystem")
    expect(JSON.stringify(manifest)).not.toContain("secret")
    expect(JSON.stringify(manifest)).not.toContain("/Users/")
  })

  it("puts only a short-lived ticket in the worker WebSocket URL", () => {
    const url = workerSocketUrl("https://brain.example/base?token=long-lived", "once")
    expect(url).toBe("wss://brain.example/ws/worker?ticket=once")
    expect(url).not.toContain("long-lived")
  })

  it("requires a private DPoP identity and owner-only file permissions", () => {
    const raw = JSON.stringify({
      baseUrl: "https://brain.example",
      deviceId: "worker-a",
      tenantId: "tenant-a",
      devicePrivateKeyJwk: { kty: "EC", d: "private" },
      serverVersion: "1.0.0",
    })
    expect(
      loadWorkerDeviceConfig("worker.json", {
        stat: () => ({ mode: 0o100600 }),
        readFile: () => raw,
      })
    ).toMatchObject({ deviceId: "worker-a" })
    expect(() =>
      loadWorkerDeviceConfig("worker.json", {
        stat: () => ({ mode: 0o100644 }),
        readFile: () => raw,
      })
    ).toThrow(/must not be readable/)
    expect(() =>
      loadWorkerDeviceConfig("worker.json", {
        stat: () => ({ mode: 0o100600 }),
        readFile: () => JSON.stringify({ baseUrl: "https://brain.example" }),
      })
    ).toThrow(/DPoP/)
  })
})
