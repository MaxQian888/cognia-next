/** @jest-environment node */
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {
  probeHermesGateway,
  readHermesGatewayProcessIdentity,
  type HermesGatewayProbeRequest,
} from "./hermes-gateway-probe"

const describePosix = process.platform === "win32" ? describe.skip : describe
describePosix("owned Hermes gateway readiness probe", () => {
  let root: string
  let home: string
  let scratch: string
  let server: net.Server | undefined
  const startedAt = Date.now() - 1000
  const fingerprint = 123456
  let payload: Record<string, unknown>
  const deps = {
    readProcessIdentity: async () => ({
      pid: process.pid,
      uid: process.getuid!(),
      startFingerprint: fingerprint,
      startedAtMs: startedAt,
    }),
  }
  const request = (): HermesGatewayProbeRequest => ({
    configKey: "configuration",
    expectedHome: home,
    ownedStateRoot: root,
    expectedPid: process.pid,
    expectedStartupTime: startedAt,
    profile: "default",
  })

  beforeEach(async () => {
    const temporaryRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir()
    scratch = await fs.mkdtemp(path.join(temporaryRoot, "hgp-"))
    // Canonicalize macOS /var before binding source-derived socket identities.
    scratch = await fs.realpath(scratch)
    root = path.join(scratch, "cognia", "external-agents", "configuration")
    home = path.join(root, "hermes")
    await fs.mkdir(home, { recursive: true, mode: 0o700 })
    await fs.chmod(root, 0o700)
    payload = {
      kind: "hermes-gateway",
      pid: process.pid,
      hermes_home: home,
      start_time: fingerprint,
      profile: "default",
      protocol: 1,
      runtime_protocol: 1,
      state: "ready",
      supervisor: "external",
      instance_id: "1".repeat(32),
      authority_epoch: 1,
      capabilities: ["session-authority-v1", "durable-admission-v1", "event-replay-v1"],
      served_profiles: [{ home, profile_id: home, name: "default" }],
      api_origin: "http://127.0.0.1:32123",
    }
    await writeState()
  })
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    await fs.rm(scratch, { recursive: true, force: true })
  })
  async function writeState(extra: Record<string, unknown> = {}) {
    await fs.writeFile(
      path.join(home, "gateway_state.json"),
      JSON.stringify({
        kind: "hermes-gateway",
        pid: process.pid,
        hermes_home: home,
        start_time: fingerprint,
        gateway_state: "running",
        updated_at: new Date().toISOString(),
        ...extra,
      }),
      { mode: 0o600 }
    )
  }
  async function listen(reply?: string) {
    // The actual managed homes are long too; exercise the official pointer contract.
    const hash = createHash("sha256").update(home).digest("hex").slice(0, 16)
    const dir = path.join(scratch, `hermes-gw-${hash}`)
    await fs.mkdir(dir, { mode: 0o700 })
    const socket = path.join(dir, "control.sock")
    await fs.writeFile(path.join(home, "gateway.sock.path"), socket, { mode: 0o600 })
    server = net.createServer((peer) => {
      peer.once("data", (data) => {
        expect(JSON.parse(data.toString())).toEqual({ protocol: 1, verb: "identify", id: 1 })
        peer.end(reply ?? `${JSON.stringify({ ok: true, protocol: 1, id: 1, result: payload })}\n`)
      })
      peer.on("error", () => undefined)
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(socket, () => resolve())
    })
    await fs.chmod(socket, 0o600)
  }

  it("accepts only an owned live runtime with its authoritative ready descriptor", async () => {
    await listen()
    await expect(probeHermesGateway(request(), deps)).resolves.toEqual({
      ready: true,
      endpoint: {
        profileId: home,
        instanceId: "1".repeat(32),
        authorityEpoch: 1,
        apiOrigin: "http://127.0.0.1:32123",
        runtimeProtocol: 1,
      },
    })
  })
  it("checks a real local process incarnation without an injected identity", async () => {
    const identity = await readHermesGatewayProcessIdentity(process.pid)
    payload.start_time = identity.startFingerprint
    await writeState({ start_time: identity.startFingerprint })
    await listen()
    await expect(
      probeHermesGateway({
        ...request(),
        expectedStartupTime: identity.startedAtMs ?? startedAt,
      })
    ).resolves.toMatchObject({ ready: true })
  })
  it("rejects arbitrary state roots and a home escaping its managed root", async () => {
    await expect(
      probeHermesGateway({ ...request(), ownedStateRoot: scratch }, deps)
    ).rejects.toThrow("invalid_owned_root")
    await expect(probeHermesGateway({ ...request(), expectedHome: scratch }, deps)).rejects.toThrow(
      "invalid_owned_home"
    )
  })
  it("rejects a symlinked managed home before socket access", async () => {
    await fs.rename(home, `${home}-real`)
    await fs.symlink(`${home}-real`, home)
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("unsafe_control_path")
  })
  it("rejects non-private directories and pointer files", async () => {
    await fs.chmod(home, 0o755)
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("unsafe_control_permissions")
    await fs.chmod(home, 0o700)
    await listen()
    await fs.chmod(path.join(home, "gateway.sock.path"), 0o644)
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("unsafe_control_permissions")
  })
  it("does not follow a pointer to an unrelated local socket", async () => {
    await fs.writeFile(path.join(home, "gateway.sock.path"), "/tmp/arbitrary/control.sock", {
      mode: 0o600,
    })
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("invalid_control_pointer")
  })
  it.each([
    { pid: process.pid + 1 },
    { start_time: fingerprint + 1000 },
    { hermes_home: "/foreign" },
  ])("rejects a stale or foreign ownership record %p", async (extra) => {
    await writeState(extra)
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("runtime_owner_mismatch")
  })
  it("rejects a recycled process and a state record predating this launch", async () => {
    await expect(
      probeHermesGateway(request(), {
        readProcessIdentity: async () => ({
          pid: process.pid,
          uid: process.getuid!(),
          startFingerprint: fingerprint + 1000,
          startedAtMs: startedAt,
        }),
      })
    ).rejects.toThrow("runtime_owner_mismatch")
    await writeState({ updated_at: new Date(startedAt - 10000).toISOString() })
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("stale_runtime_state")
  })
  it.each([
    { runtime_protocol: 2 },
    { state: "starting" },
    { authority_epoch: 0 },
    { instance_id: "" },
    { capabilities: [] },
    { api_origin: "http://example.com:80" },
    { pid: process.pid + 1 },
    { served_profiles: [] },
  ])("refuses an unready or mismatched identity %p", async (extra) => {
    Object.assign(payload, extra)
    await listen()
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow()
  })
  it("bounds and validates the control envelope", async () => {
    await listen(`${JSON.stringify({ ok: true, protocol: 1, id: 2, result: payload })}\n`)
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("invalid_control_response")
  })
  it("bounds malicious response bytes before decoding JSON", async () => {
    await listen(`${"x".repeat(512 * 1024 + 1)}\n`)
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("oversized_control_response")
  })
  it("times out a connected control socket that never sends its response", async () => {
    await listen("")
    server!.removeAllListeners("connection")
    server!.on("connection", (peer) => {
      peer.on("data", () => undefined)
    })
    await expect(probeHermesGateway(request(), deps)).rejects.toThrow("control_timeout")
  })
})
