import { generateKeyPairSync, sign as edSign } from "node:crypto"

import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"
import {
  compatibilityKeyId,
  manifestSigningPayload,
} from "@cognia/agent-config-types/compatibility-manifest"

import {
  CertificationStore,
  installCertificationRuntime,
  recordCertifiedCapabilityOutcome,
  resolveActiveCertification,
  type CertificationFs,
} from "./certification-store"

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
      suiteVersion: "2",
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

  it("verifies Ed25519 signatures and rejects wrong keys / tampered payloads / unsigned", async () => {
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

    await expect(store.verifySignature(signed, pem)).resolves.toBe(true)
    await expect(store.verifySignature(signed, wrongPem)).resolves.toBe(false)
    await expect(store.verifySignature(unsigned, pem)).resolves.toBe(false)
    const tampered = { ...signed, evidence: "native" as const }
    await expect(store.verifySignature(tampered, pem)).resolves.toBe(false)
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

describe("active certification runtime", () => {
  afterEach(() => {
    installCertificationRuntime(null)
  })

  it("projects the signed active bundle into a certified resolver path", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const fs = memFs()
    const unsigned = manifest({
      capabilities: { streaming: "supported", compaction: "unsupported" },
    })
    const signed = {
      ...unsigned,
      signature: edSign(
        null,
        Buffer.from(manifestSigningPayload(unsigned), "utf8"),
        privateKey
      ).toString("base64"),
    }
    await seedBundle(fs, signed)
    fs.files.set(
      `${ROOT}/active-bundle.json`,
      JSON.stringify({ bundleId: signed.bundleId, activatedAt: "2026-08-09T00:00:00.000Z" })
    )
    const store = new CertificationStore(fs, ROOT)
    installCertificationRuntime({
      store,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      current: {
        agentSdkVersion: signed.key.agentSdkVersion,
        gatewayVersion: signed.key.gatewayVersion,
        claudeCodeVersion: signed.key.claudeCodeVersion,
        suiteVersion: signed.key.suiteVersion,
      },
    })

    await expect(
      resolveActiveCertification({
        runtime: signed.key.runtime,
        ingressProtocol: signed.key.ingressProtocol,
        routeMode: signed.key.routeMode,
        translationMode: signed.key.translationMode,
        deploymentRef: signed.key.deploymentRef,
        model: signed.key.model,
        requires: ["streaming"],
        prefers: ["compaction"],
      })
    ).resolves.toEqual({
      accepted: true,
      certifiedPath: {
        recordRef: expect.stringContaining("bundle-a:"),
        evidence: "cognia-verified",
        suiteVersion: "2",
        disabledOptional: ["compaction"],
      },
    })
  })

  it("fails closed when the active bundle describes another execution path", async () => {
    const fs = memFs()
    const active = manifest()
    await seedBundle(fs, active)
    fs.files.set(
      `${ROOT}/active-bundle.json`,
      JSON.stringify({ bundleId: active.bundleId, activatedAt: "2026-08-09T00:00:00.000Z" })
    )
    installCertificationRuntime({
      store: new CertificationStore(fs, ROOT),
      publicKeyPem: "unused",
      current: {
        agentSdkVersion: active.key.agentSdkVersion,
        gatewayVersion: active.key.gatewayVersion,
        claudeCodeVersion: active.key.claudeCodeVersion,
        suiteVersion: active.key.suiteVersion,
      },
    })

    await expect(
      resolveActiveCertification({
        ...active.key,
        model: "different-model",
        requires: [],
        prefers: [],
      })
    ).resolves.toEqual({ accepted: false, reasons: ["active manifest path mismatch: model"] })
  })

  it("keeps a hard-required capability blocked while its certified health circuit is open", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const fs = memFs()
    const unsigned = manifest({ capabilities: { streaming: "supported" } })
    const signed = {
      ...unsigned,
      signature: edSign(
        null,
        Buffer.from(manifestSigningPayload(unsigned), "utf8"),
        privateKey
      ).toString("base64"),
    }
    await seedBundle(fs, signed)
    fs.files.set(
      `${ROOT}/active-bundle.json`,
      JSON.stringify({ bundleId: signed.bundleId, activatedAt: "2026-08-09T00:00:00.000Z" })
    )
    fs.files.set(
      `${ROOT}/health.json`,
      JSON.stringify([
        {
          keyId: compatibilityKeyId(signed.key),
          capability: "streaming",
          consecutiveFailures: 3,
          openUntil: "2099-01-01T00:00:00.000Z",
        },
      ])
    )
    installCertificationRuntime({
      store: new CertificationStore(fs, ROOT),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      current: {
        agentSdkVersion: signed.key.agentSdkVersion,
        gatewayVersion: signed.key.gatewayVersion,
        claudeCodeVersion: signed.key.claudeCodeVersion,
        suiteVersion: signed.key.suiteVersion,
      },
    })

    await expect(
      resolveActiveCertification({ ...signed.key, requires: ["streaming"], prefers: [] })
    ).resolves.toEqual({
      accepted: false,
      reasons: ["required capability streaming is unknown"],
      blockedRequired: ["streaming"],
    })
  })

  it("does not let an untrusted manifest supply blocked-required capability verdicts", async () => {
    const fs = memFs()
    const active = manifest({ capabilities: { streaming: "unsupported" } })
    await seedBundle(fs, active)
    fs.files.set(
      `${ROOT}/active-bundle.json`,
      JSON.stringify({ bundleId: active.bundleId, activatedAt: "2026-08-09T00:00:00.000Z" })
    )
    installCertificationRuntime({
      store: new CertificationStore(fs, ROOT),
      publicKeyPem: "not-a-public-key",
      current: {
        agentSdkVersion: active.key.agentSdkVersion,
        gatewayVersion: active.key.gatewayVersion,
        claudeCodeVersion: active.key.claudeCodeVersion,
        suiteVersion: active.key.suiteVersion,
      },
    })

    await expect(
      resolveActiveCertification({ ...active.key, requires: ["streaming"], prefers: [] })
    ).resolves.toEqual(
      expect.objectContaining({
        accepted: false,
        reasons: expect.arrayContaining([
          "manifest signature did not verify",
          "required capability streaming is unsupported",
        ]),
      })
    )
    expect(
      await resolveActiveCertification({
        ...active.key,
        requires: ["streaming"],
        prefers: [],
      })
    ).not.toHaveProperty("blockedRequired")
  })

  it("persists capability outcomes through the existing health overlay", async () => {
    const fs = memFs()
    installCertificationRuntime({
      store: new CertificationStore(fs, ROOT),
      publicKeyPem: "unused",
      current: {
        agentSdkVersion: "0.3.220",
        gatewayVersion: "0.1.0",
        claudeCodeVersion: "2.1.220",
        suiteVersion: "2",
      },
    })

    await recordCertifiedCapabilityOutcome("bundle-a:key-a", "compaction", "failure")
    await expect(new CertificationStore(fs, ROOT).readHealth()).resolves.toEqual([
      expect.objectContaining({
        keyId: "key-a",
        capability: "compaction",
        consecutiveFailures: 1,
      }),
    ])

    await recordCertifiedCapabilityOutcome("bundle-a:key-a", "compaction", "success")
    await expect(new CertificationStore(fs, ROOT).readHealth()).resolves.toEqual([])
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
