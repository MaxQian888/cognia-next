/** @jest-environment jsdom */
// Provider Profile Store accessors — derived-set replacement, CAS version
// bumps, legacy lookups, and redacted export/import against real Dexie over
// fake-indexeddb.

import "fake-indexeddb/auto"
import type { DerivedProfiles } from "@cognia/provider-types/profile-migration"

import {
  deploymentsForLegacyProvider,
  exportStoredProfilesRedacted,
  getDeploymentProfile,
  getProfileMeta,
  importStoredProfiles,
  listDeploymentProfiles,
  listProviderProfiles,
  listTransportProfiles,
  putDerivedProfiles,
} from "./provider-profiles"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

function derivedFixture(suffix = ""): DerivedProfiles {
  return {
    providerProfiles: [
      { id: "zhipu", displayName: `Zhipu${suffix}`, deploymentRefs: ["glm-anthropic"] },
    ],
    deploymentProfiles: [
      {
        id: "glm-anthropic",
        providerRef: "zhipu",
        endpoint: "https://open.bigmodel.cn/api/anthropic",
        transportProfileRef: "tp-anthropic-x-api-key",
        credentialProfileRef: { kind: "legacy-provider-settings", providerId: "glm-anthropic" },
        models: [{ id: "glm-4.6" }],
        legacyProviderId: "glm-anthropic",
        enabled: true,
      },
    ],
    transportProfiles: [
      { id: "tp-anthropic-x-api-key", protocol: "anthropic", auth: { scheme: "x-api-key" } },
    ],
    legacyAliases: { "glm-anthropic": "glm-anthropic" },
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("putDerivedProfiles", () => {
  it("replaces the document set wholesale and bumps profileVersion monotonically", async () => {
    // Fresh installs skip Dexie upgrade hooks, so meta is absent until the
    // first derived write (missing row reads as version 0).
    expect(await getProfileMeta()).toBeUndefined()

    const v1 = await putDerivedProfiles(derivedFixture())
    expect(v1).toBe(1)
    expect((await listProviderProfiles()).map((p) => p.id)).toEqual(["zhipu"])

    // A second write with fewer rows CLEARS what the derivation dropped.
    const next = derivedFixture(" v2")
    next.transportProfiles = []
    const v2 = await putDerivedProfiles(next)
    expect(v2).toBe(2)
    expect(await listTransportProfiles()).toEqual([])
    expect((await listProviderProfiles())[0].displayName).toBe("Zhipu v2")
    expect((await getProfileMeta())?.profileVersion).toBe(2)
  })

  it("serves lookups by id and legacy provider id", async () => {
    await putDerivedProfiles(derivedFixture())
    expect((await getDeploymentProfile("glm-anthropic"))?.providerRef).toBe("zhipu")
    expect(await getDeploymentProfile("missing")).toBeUndefined()
    const byLegacy = await deploymentsForLegacyProvider("glm-anthropic")
    expect(byLegacy).toHaveLength(1)
    expect(await deploymentsForLegacyProvider("nope")).toEqual([])
    expect(await listDeploymentProfiles()).toHaveLength(1)
  })
})

describe("export / import", () => {
  it("exports a redacted payload that re-imports cleanly with a version bump", async () => {
    await putDerivedProfiles(derivedFixture())
    const exported = await exportStoredProfilesRedacted()
    expect(exported.profileVersion).toBe(1)
    expect(exported.legacyAliases).toEqual({ "glm-anthropic": "glm-anthropic" })
    expect(JSON.stringify(exported).toLowerCase()).not.toContain('"apikey"')

    const result = await importStoredProfiles(JSON.parse(JSON.stringify(exported)))
    expect(result).toEqual({ ok: true, profileVersion: 2 })
  })

  it("refuses invalid payloads without touching the store", async () => {
    await putDerivedProfiles(derivedFixture())
    const before = await getProfileMeta()

    const rejected = await importStoredProfiles({ schemaVersion: 999 })
    expect(rejected.ok).toBe(false)
    expect((await getProfileMeta())?.profileVersion).toBe(before?.profileVersion)
  })
})
