import { generateKeyPairSync, sign as edSign } from "node:crypto"

import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"
import { manifestSigningPayload } from "@cognia/agent-config-types/compatibility-manifest"

import { CertificationStore, type CertificationFs } from "./certification-store"

function memFs(): CertificationFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async readFile(path) {
      return files.get(path) ?? null
    },
    async writeFile(path, content) {
      files.set(path, content)
    },
    async listDir(path) {
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0])
      }
      if (names.size === 0) throw new Error("ENOENT")
      return [...names]
    },
  }
}

function manifest(overrides: Partial<CompatibilityManifest> = {}): CompatibilityManifest {
  return {
    manifestVersion: 1,
    bundleId: "bundle-a",
    key: {
      runtime: "claude-agent-sdk",
      ingressProtocol: "anthropic",
      routeMode: "gateway",
      translationMode: "passthrough",
      deploymentRef: "conf-anthropic",
      model: "claude-opus-4-8",
      agentSdkVersion: "0.3.183",
      claudeCodeVersion: "2.1.0",
      gatewayVersion: "0.1.0",
      suiteVersion: "1",
    },
    evidence: "cognia-verified",
    level: "core",
    capabilities: { streaming: "supported" },
    suiteResults: [{ caseId: "text-sse", passed: true }],
    parity: { passed: true },
    knownLosses: [],
    issuer: "cognia-ci",
    issuedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  }
}

const ROOT = "/data/agent-certification"

async function seedBundle(fs: ReturnType<typeof memFs>, m: CompatibilityManifest) {
  fs.files.set(`${ROOT}/bundles/${m.bundleId}/manifest.json`, JSON.stringify(m))
}

describe("CertificationStore", () => {
  it("lists bundles and reads valid manifests only", async () => {
    const fs = memFs()
    await seedBundle(fs, manifest())
    fs.files.set(`${ROOT}/bundles/bundle-broken/manifest.json`, "{not json")
    fs.files.set(`${ROOT}/bundles/bundle-invalid/manifest.json`, JSON.stringify({ nope: 1 }))
    const store = new CertificationStore(fs, ROOT)

    expect(await store.listBundles()).toEqual(["bundle-a", "bundle-broken", "bundle-invalid"])
    expect((await store.readManifest("bundle-a"))?.bundleId).toBe("bundle-a")
    expect(await store.readManifest("bundle-broken")).toBeNull()
    expect(await store.readManifest("bundle-invalid")).toBeNull()
    expect(await store.readManifest("missing")).toBeNull()
  })

  it("verifies Ed25519 signatures and rejects wrong keys / tampered payloads / unsigned", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const { publicKey: wrongKey } = generateKeyPairSync("ed25519")
    const store = new CertificationStore(memFs(), ROOT)

    const unsigned = manifest()
    const signature = edSign(
      null,
      Buffer.from(manifestSigningPayload(unsigned), "utf8"),
      privateKey
    )
    const signed = { ...unsigned, signature: signature.toString("base64") }
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString()
    const wrongPem = wrongKey.export({ type: "spki", format: "pem" }).toString()

    expect(store.verifySignature(signed, pem)).toBe(true)
    expect(store.verifySignature(signed, wrongPem)).toBe(false)
    expect(store.verifySignature(unsigned, pem)).toBe(false)
    const tampered = { ...signed, evidence: "native" as const }
    expect(store.verifySignature(tampered, pem)).toBe(false)
  })

  it("CAS-activates bundles, records the previous, and rolls back", async () => {
    const fs = memFs()
    await seedBundle(fs, manifest({ bundleId: "bundle-a" }))
    await seedBundle(fs, manifest({ bundleId: "bundle-b" }))
    const store = new CertificationStore(fs, ROOT)

    const first = await store.activateBundle("bundle-a", null)
    expect(first.bundleId).toBe("bundle-a")
    const second = await store.activateBundle("bundle-b", first)
    expect(second.previousBundleId).toBe("bundle-a")

    // CAS: an activation racing on a stale expectation fails loudly.
    await expect(store.activateBundle("bundle-a", first)).rejects.toThrow(/activation conflict/)
    // Unknown bundle fails before touching the pointer.
    await expect(store.activateBundle("ghost", second)).rejects.toThrow(/no valid manifest/)

    const rolledBack = await store.rollback()
    expect(rolledBack.bundleId).toBe("bundle-a")
    expect(rolledBack.previousBundleId).toBe("bundle-b")
  })

  it("health overlay round-trips and tolerates absence/corruption", async () => {
    const fs = memFs()
    const store = new CertificationStore(fs, ROOT)
    expect(await store.readHealth()).toEqual([])
    await store.writeHealth([{ keyId: "k", capability: "mcp", consecutiveFailures: 1 }])
    expect(await store.readHealth()).toHaveLength(1)
    fs.files.set(`${ROOT}/health.json`, "{broken")
    expect(await store.readHealth()).toEqual([])
  })
})

describe("cross-language signing payload parity", () => {
  it("the TS manifestSigningPayload matches the emit-manifest (mjs) encoder", async () => {
    // A drift here would make CI-signed bundles unverifiable by the store.
    const { signingPayload } =
      await import("../../../../tests/conformance/harness/emit-manifest.mjs")
    const m = manifest({ signature: "AAAA" })
    expect(signingPayload(m)).toBe(manifestSigningPayload(m))
  })
})
