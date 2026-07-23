/** @jest-environment jsdom */
// Certification projection: rebuild-from-files authority, per-deployment
// lookups, and full-clear semantics on rebuild.

import "fake-indexeddb/auto"
import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"

import {
  CertificationStore,
  type CertificationFs,
} from "@/lib/ai/agent/execution/certification-store"

import {
  listCompatibilityRecords,
  rebuildCompatibilityProjection,
  recordsForDeployment,
} from "./agent-compatibility"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

function manifest(bundleId: string, deploymentRef: string): CompatibilityManifest {
  return {
    manifestVersion: 1,
    bundleId,
    key: {
      runtime: "claude-agent-sdk",
      ingressProtocol: "anthropic",
      routeMode: "gateway",
      translationMode: "passthrough",
      deploymentRef,
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
  }
}

function memStore(manifests: CompatibilityManifest[]): CertificationStore {
  const files = new Map<string, string>()
  for (const m of manifests) {
    files.set(`/root/bundles/${m.bundleId}/manifest.json`, JSON.stringify(m))
  }
  const fs: CertificationFs = {
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
  return new CertificationStore(fs, "/root")
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("rebuildCompatibilityProjection", () => {
  it("indexes every valid manifest and clears rows the files no longer contain", async () => {
    const first = memStore([manifest("bundle-a", "dep-1"), manifest("bundle-b", "dep-2")])
    expect(await rebuildCompatibilityProjection(first)).toBe(2)
    expect((await listCompatibilityRecords()).map((r) => r.bundleId).sort()).toEqual([
      "bundle-a",
      "bundle-b",
    ])
    expect(await recordsForDeployment("dep-1")).toHaveLength(1)

    // Authority shrank: the projection must shrink with it, not accumulate.
    const second = memStore([manifest("bundle-b", "dep-2")])
    expect(await rebuildCompatibilityProjection(second)).toBe(1)
    expect(await listCompatibilityRecords()).toHaveLength(1)
    expect(await recordsForDeployment("dep-1")).toEqual([])
  })

  it("tolerates an empty bundle directory", async () => {
    expect(await rebuildCompatibilityProjection(memStore([]))).toBe(0)
    expect(await listCompatibilityRecords()).toEqual([])
  })
})
