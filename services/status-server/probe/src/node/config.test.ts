import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  ConfigError,
  loadProbeSecret,
  parseMirrorOnlyConfig,
  parseProbeConfig,
  readConfigFile,
} from "./config"

const exampleFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../deploy/probe.config.example.json"
)

async function example(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(exampleFile, "utf8")) as Record<string, unknown>
}

function withProfiles(base: Record<string, unknown>, profiles: unknown[]) {
  return { ...base, profiles }
}

describe("parseProbeConfig", () => {
  it("accepts the shipped example", async () => {
    const config = parseProbeConfig(await example())
    expect(config.apiBase).toBe("https://status.cognia.cn/api/status/v1")
    expect(config.signalingUrl).toBe("wss://signaling.cognia.cn/signaling")
    expect(config.profiles.map((profile) => [profile.id, profile.origin])).toEqual([
      ["native", null],
      ["web", "https://cognia.cn"],
      ["ios", "capacitor://localhost"],
      ["android", "https://localhost"],
    ])
    expect(config.mirror).toMatchObject({
      enabled: false,
      port: 8080,
      sourceApiBase: config.apiBase,
    })
    expect(config.allowLoopbackHttp).toBe(false)
  })

  it.each<[string, (base: Record<string, unknown>) => unknown, RegExp]>([
    [
      "http apiBase",
      (base) => ({ ...base, apiBase: "http://status.cognia.cn/api/status/v1" }),
      /apiBase/,
    ],
    [
      "apiBase with query",
      (base) => ({ ...base, apiBase: "https://status.cognia.cn/api?x=1" }),
      /apiBase/,
    ],
    [
      "non-wss signaling",
      (base) => ({ ...base, signalingUrl: "https://signaling.cognia.cn/signaling" }),
      /signalingUrl/,
    ],
    [
      "ws signaling off loopback",
      (base) => ({ ...base, signalingUrl: "ws://signaling.cognia.cn/signaling" }),
      /signalingUrl/,
    ],
    ["bad probe id", (base) => ({ ...base, probeId: "has space" }), /probeId/],
    ["relative spool", (base) => ({ ...base, spoolDir: "spool" }), /spoolDir/],
    ["negative revision", (base) => ({ ...base, registryRevision: -1 }), /registryRevision/],
    [
      "native with Origin",
      (base) =>
        withProfiles(base, [{ id: "native", origin: "https://x.example", httpCadenceSeconds: 60 }]),
      /native/,
    ],
    [
      "web without Origin",
      (base) => withProfiles(base, [{ id: "web", origin: null, protocolCadenceSeconds: 300 }]),
      /origin/,
    ],
    [
      "Origin with a path",
      (base) =>
        withProfiles(base, [
          { id: "web", origin: "https://cognia.cn/x", protocolCadenceSeconds: 300 },
        ]),
      /exact origin/,
    ],
    [
      "odd cadence",
      (base) => withProfiles(base, [{ id: "native", origin: null, httpCadenceSeconds: 90 }]),
      /cadence/,
    ],
    ["no cadence", (base) => withProfiles(base, [{ id: "native", origin: null }]), /cadence/],
    [
      "duplicate profile",
      (base) =>
        withProfiles(base, [
          { id: "native", origin: null, httpCadenceSeconds: 60 },
          { id: "native", origin: null, httpCadenceSeconds: 60 },
        ]),
      /duplicate/,
    ],
    [
      "unknown profile",
      (base) => withProfiles(base, [{ id: "desktop", origin: null, httpCadenceSeconds: 60 }]),
      /unknown profile/,
    ],
    ["empty profiles", (base) => withProfiles(base, []), /profiles/],
    [
      "http webhook",
      (base) => ({ ...base, alertWebhook: "http://hooks.example/x" }),
      /alertWebhook/,
    ],
    [
      "bad mirror port",
      (base) => ({ ...base, mirror: { ...(base.mirror as object), port: 70_000 } }),
      /mirror.port/,
    ],
  ])("rejects %s", async (_label, mutate, message) => {
    const candidate = mutate(await example())
    expect(() => parseProbeConfig(candidate)).toThrow(ConfigError)
    expect(() => parseProbeConfig(candidate)).toThrow(message)
  })

  it("allows loopback http/ws only when explicitly enabled", async () => {
    const base = await example()
    const local = {
      ...base,
      allowLoopbackHttp: true,
      apiBase: "http://127.0.0.1:8787/api/status/v1",
      signalingUrl: "ws://127.0.0.1:8788/signaling",
      statusPageUrl: "http://localhost:8787/status/",
    }
    expect(parseProbeConfig(local).apiBase).toBe("http://127.0.0.1:8787/api/status/v1")
    expect(() => parseProbeConfig({ ...local, allowLoopbackHttp: false })).toThrow(ConfigError)
  })
})

describe("parseMirrorOnlyConfig", () => {
  it("needs only apiBase and the mirror block", () => {
    const config = parseMirrorOnlyConfig({
      apiBase: "https://status.cognia.cn/api/status/v1",
      mirror: { dataDir: "/var/lib/m", assetsDir: "/srv/m/current" },
    })
    expect(config.mirror).toEqual({
      enabled: true,
      dataDir: "/var/lib/m",
      assetsDir: "/srv/m/current",
      host: "127.0.0.1",
      port: 8080,
      syncIntervalSeconds: 300,
      sourceApiBase: "https://status.cognia.cn/api/status/v1",
    })
  })

  it("refuses a config without a mirror block", () => {
    expect(() =>
      parseMirrorOnlyConfig({ apiBase: "https://status.cognia.cn/api/status/v1" })
    ).toThrow(/mirror/)
  })
})

describe("files", () => {
  it("reads config JSON and reports unreadable or invalid files without content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "probe-config-"))
    const bad = path.join(dir, "bad.json")
    await writeFile(bad, "{ not json")
    await expect(readConfigFile(bad)).rejects.toThrow("config file is not valid JSON")
    await expect(readConfigFile(path.join(dir, "missing.json"))).rejects.toThrow(/ENOENT/)
  })

  it("loads a base64url secret of at least 32 bytes and flags loose permissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "probe-secret-"))
    const file = path.join(dir, "secret")
    await writeFile(file, `${Buffer.alloc(32, 7).toString("base64url")}\n`)
    await chmod(file, 0o600)
    const strict = await loadProbeSecret(file)
    expect(strict.secret.byteLength).toBe(32)
    expect(strict.permissive).toBe(false)
    await chmod(file, 0o644)
    expect((await loadProbeSecret(file)).permissive).toBe(true)

    await writeFile(file, Buffer.alloc(16, 1).toString("base64url"))
    await expect(loadProbeSecret(file)).rejects.toThrow(/at least 32 bytes/)
    await writeFile(file, "not*base64")
    await expect(loadProbeSecret(file)).rejects.toThrow(ConfigError)
  })
})
