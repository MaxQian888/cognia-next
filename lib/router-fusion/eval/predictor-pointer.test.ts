/**
 * predictor-pointer — the learned router's active-manifest pointer as an
 * evaluation configuration target (ADR-0188 B6).
 *
 * The two async seams are mocked: the settings read (store / account row) and
 * the fusion-store provider (which resolves the account database). The store
 * hands back a real `FusionDB` on fake-indexeddb, so the registry moves under
 * test are the real ones.
 */

import "fake-indexeddb/auto"

jest.mock("../gate/current-settings", () => ({ currentRouterFusionGateSettings: jest.fn() }))
jest.mock("../chat/store-provider", () => ({ currentFusionStore: jest.fn() }))

import { ROUTER_FUSION_SURFACES } from "@cognia/router-fusion/settings/switches"

import { currentFusionStore } from "../chat/store-provider"
import { FusionDB } from "../db/fusion-db"
import { currentRouterFusionGateSettings } from "../gate/current-settings"
import {
  parseActivePredictorPointer,
  readActivePredictorPointer,
  RoutingPredictorTargetUnavailableError,
  writeActivePredictorPointer,
} from "./predictor-pointer"
import { ROUTING_FEATURES_VERSION } from "./routing-sample"
import { activatePredictorManifest, sealPredictorManifest } from "./routing-store"

const settingsMock = currentRouterFusionGateSettings as jest.MockedFunction<
  typeof currentRouterFusionGateSettings
>
const storeMock = currentFusionStore as jest.MockedFunction<typeof currentFusionStore>

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
const SHA_C = "0123456789abcdef".repeat(4)

const ON = { routerFusion: { enabled: true, surfaces: { chat: true } } }

function useSettings(value: unknown): void {
  settingsMock.mockResolvedValue(
    value as Awaited<ReturnType<typeof currentRouterFusionGateSettings>>
  )
}

let seq = 0
let db: FusionDB

async function seal(
  manifestSha256: string,
  overrides: { kind?: "training" | "published"; featuresVersion?: string } = {}
): Promise<void> {
  await sealPredictorManifest(db, {
    manifestSha256,
    kind: overrides.kind ?? "published",
    featuresVersion: overrides.featuresVersion ?? ROUTING_FEATURES_VERSION,
    manifest: { sha256: manifestSha256 },
    label: "live",
    gateVerdict: "pass",
    gateReasons: [],
    now: 1_000,
  })
}

beforeEach(() => {
  seq += 1
  db = new FusionDB(`predictor-pointer-test-${seq}`)
  settingsMock.mockReset()
  storeMock.mockReset()
  storeMock.mockResolvedValue({ db } as unknown as Awaited<ReturnType<typeof currentFusionStore>>)
  useSettings(ON)
})

afterEach(async () => {
  await db.delete()
})

describe("parseActivePredictorPointer", () => {
  it("reads a missing, undefined or null digest as 'learned router off'", () => {
    expect(parseActivePredictorPointer({})).toEqual({ manifestSha256: null })
    expect(parseActivePredictorPointer({ manifestSha256: undefined })).toEqual({
      manifestSha256: null,
    })
    expect(parseActivePredictorPointer({ manifestSha256: null })).toEqual({
      manifestSha256: null,
    })
  })

  it("accepts a 64-character lowercase hex digest and drops anything else in the value", () => {
    expect(parseActivePredictorPointer({ manifestSha256: SHA_C, extra: "ignored" })).toEqual({
      manifestSha256: SHA_C,
    })
  })

  it.each([
    ["an empty string", ""],
    ["an uppercase digest", SHA_C.toUpperCase()],
    ["63 characters", SHA_C.slice(1)],
    ["65 characters", `${SHA_C}0`],
    ["a non-hex character", `${SHA_C.slice(1)}g`],
    ["surrounding whitespace", ` ${SHA_C} `],
    ["a number", 42],
    ["an object", { sha256: SHA_C }],
    ["a boolean", false],
  ])("refuses %s", (_label, manifestSha256) => {
    expect(() => parseActivePredictorPointer({ manifestSha256 })).toThrow(
      "manifestSha256 must be a 64-character hex digest or null"
    )
  })
})

describe("RoutingPredictorTargetUnavailableError", () => {
  it("names itself and says why the pointer cannot move", () => {
    const error = new RoutingPredictorTargetUnavailableError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("RoutingPredictorTargetUnavailableError")
    expect(error.message).toMatch(/off on every surface/)
  })
})

const OFF_SETTINGS: Array<[string, unknown]> = [
  ["unreadable settings (null)", null],
  ["settings without a Router + Fusion block", {}],
  ["a null Router + Fusion block", { routerFusion: null }],
  ["the master switch off", { routerFusion: { enabled: false, surfaces: { chat: true } } }],
  [
    "a truthy-but-not-boolean master switch",
    { routerFusion: { enabled: "true", surfaces: { chat: true } } },
  ],
  ["every surface off", { routerFusion: { enabled: true, surfaces: {} } }],
  ["no surfaces map", { routerFusion: { enabled: true, surfaces: null } }],
  [
    "a truthy-but-not-boolean surface switch",
    { routerFusion: { enabled: true, surfaces: { chat: 1 } } },
  ],
]

describe("readActivePredictorPointer", () => {
  it.each(OFF_SETTINGS)(
    "refuses without opening the fusion database with %s",
    async (_label, settings) => {
      useSettings(settings)
      await expect(readActivePredictorPointer()).rejects.toBeInstanceOf(
        RoutingPredictorTargetUnavailableError
      )
      expect(storeMock).not.toHaveBeenCalled()
    }
  )

  it.each([...ROUTER_FUSION_SURFACES])(
    "is available when only the %s surface is on",
    async (surface) => {
      useSettings({ routerFusion: { enabled: true, surfaces: { [surface]: true } } })
      await expect(readActivePredictorPointer()).resolves.toEqual({ manifestSha256: null })
      expect(storeMock).toHaveBeenCalledTimes(1)
    }
  )

  it("answers null while a manifest is sealed but was never promoted", async () => {
    await seal(SHA_A)
    await expect(readActivePredictorPointer()).resolves.toEqual({ manifestSha256: null })
  })

  it("answers the digest of the active manifest", async () => {
    await seal(SHA_A)
    await seal(SHA_B)
    await activatePredictorManifest(db, SHA_B, { now: 2_000 })
    await expect(readActivePredictorPointer()).resolves.toEqual({ manifestSha256: SHA_B })
  })

  it("surfaces a store that cannot be opened instead of answering 'off'", async () => {
    const fault = new Error("The account database is not available.")
    storeMock.mockRejectedValue(fault)
    await expect(readActivePredictorPointer()).rejects.toBe(fault)
  })
})

describe("writeActivePredictorPointer", () => {
  it.each(OFF_SETTINGS)(
    "refuses without touching the registry with %s",
    async (_label, settings) => {
      await seal(SHA_A)
      await activatePredictorManifest(db, SHA_A, { now: 2_000 })
      useSettings(settings)
      await expect(
        writeActivePredictorPointer({ manifestSha256: null }, { now: 3_000 })
      ).rejects.toBeInstanceOf(RoutingPredictorTargetUnavailableError)
      expect(storeMock).not.toHaveBeenCalled()
      expect(await db.fusionPredictorManifests.get(SHA_A)).toMatchObject({
        active: 1,
        deactivatedAt: null,
      })
    }
  )

  it("promotes a sealed, published manifest", async () => {
    await seal(SHA_A)
    await writeActivePredictorPointer({ manifestSha256: SHA_A }, { now: 5_000 })
    expect(await db.fusionPredictorManifests.get(SHA_A)).toMatchObject({
      active: 1,
      activatedAt: 5_000,
      deactivatedAt: null,
      previousManifestSha256: null,
    })
    await expect(readActivePredictorPointer()).resolves.toEqual({ manifestSha256: SHA_A })
  })

  it("moves the pointer and remembers the manifest it replaced for rollback", async () => {
    await seal(SHA_A)
    await seal(SHA_B)
    await writeActivePredictorPointer({ manifestSha256: SHA_A }, { now: 5_000 })
    await writeActivePredictorPointer({ manifestSha256: SHA_B }, { now: 6_000 })
    expect(await db.fusionPredictorManifests.get(SHA_A)).toMatchObject({
      active: 0,
      deactivatedAt: 6_000,
    })
    expect(await db.fusionPredictorManifests.get(SHA_B)).toMatchObject({
      active: 1,
      activatedAt: 6_000,
      previousManifestSha256: SHA_A,
    })
    const active = await db.fusionPredictorManifests.filter((row) => row.active === 1).toArray()
    expect(active.map((row) => row.manifestSha256)).toEqual([SHA_B])
  })

  it("switches the learned router off on null, deleting nothing", async () => {
    await seal(SHA_A)
    await writeActivePredictorPointer({ manifestSha256: SHA_A }, { now: 5_000 })
    await writeActivePredictorPointer({ manifestSha256: null }, { now: 7_000 })
    expect(await db.fusionPredictorManifests.get(SHA_A)).toMatchObject({
      active: 0,
      deactivatedAt: 7_000,
    })
    await expect(readActivePredictorPointer()).resolves.toEqual({ manifestSha256: null })
  })

  it("treats null as a no-op when nothing is active", async () => {
    await seal(SHA_A)
    await expect(
      writeActivePredictorPointer({ manifestSha256: null }, { now: 7_000 })
    ).resolves.toBeUndefined()
    expect(await db.fusionPredictorManifests.get(SHA_A)).toMatchObject({
      active: 0,
      deactivatedAt: null,
    })
  })

  it("refuses a digest the registry has never sealed", async () => {
    await expect(
      writeActivePredictorPointer({ manifestSha256: SHA_C }, { now: 5_000 })
    ).rejects.toMatchObject({ name: "RoutingRegistryError", code: "MANIFEST_NOT_FOUND" })
  })

  it("refuses a training manifest: only a published one may act", async () => {
    await seal(SHA_A, { kind: "training" })
    await expect(
      writeActivePredictorPointer({ manifestSha256: SHA_A }, { now: 5_000 })
    ).rejects.toMatchObject({ name: "RoutingRegistryError", code: "NOT_PUBLISHED" })
    expect(await db.fusionPredictorManifests.get(SHA_A)).toMatchObject({ active: 0 })
  })

  it("refuses a manifest trained on another feature encoding than this build's", async () => {
    await seal(SHA_A, { featuresVersion: "router-fusion-features/0" })
    await expect(
      writeActivePredictorPointer({ manifestSha256: SHA_A }, { now: 5_000 })
    ).rejects.toMatchObject({ name: "RoutingRegistryError", code: "FEATURES_VERSION_MISMATCH" })
    await expect(readActivePredictorPointer()).resolves.toEqual({ manifestSha256: null })
  })

  it("round-trips a value a generic apply hands back", async () => {
    await seal(SHA_C)
    const parsed = parseActivePredictorPointer({ manifestSha256: SHA_C })
    await writeActivePredictorPointer(parsed, { now: 5_000 })
    await expect(readActivePredictorPointer()).resolves.toEqual(parsed)
  })
})
