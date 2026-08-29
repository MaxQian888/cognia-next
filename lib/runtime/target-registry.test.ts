import "fake-indexeddb/auto"

import Dexie from "dexie"

import {
  DEFAULT_STANDALONE_TARGET_ID,
  encryptedRuntimeTargetDatabaseName,
  RUNTIME_TARGET_REGISTRY_DB_NAME,
  RuntimeTargetRegistry,
  runtimeTargetDatabaseName,
} from "./target-registry"

const ACCOUNT_ID = "acct_runtime"

beforeEach(async () => {
  delete process.env.NEXT_PUBLIC_ALLOW_INSECURE_COMPANION_HTTP
  await Dexie.delete(RUNTIME_TARGET_REGISTRY_DB_NAME)
})

afterAll(async () => {
  await Dexie.delete(RUNTIME_TARGET_REGISTRY_DB_NAME)
})

it("creates and activates one default standalone target per account", async () => {
  const registry = new RuntimeTargetRegistry()

  const target = await registry.ensureDefaultActiveTarget(ACCOUNT_ID, 10)

  expect(target).toMatchObject({
    accountId: ACCOUNT_ID,
    id: DEFAULT_STANDALONE_TARGET_ID,
    kind: "standalone",
    lastUsedAt: 10,
  })
  await expect(registry.getActiveTarget(ACCOUNT_ID)).resolves.toEqual(target)
})

it("keeps multiple targets while activating only one", async () => {
  const registry = new RuntimeTargetRegistry()
  await registry.ensureDefaultActiveTarget(ACCOUNT_ID, 10)
  await registry.addTarget({
    accountId: ACCOUNT_ID,
    id: "desktop-studio",
    kind: "companion",
    hostKind: "desktop",
    label: "Studio Mac",
    now: 20,
  })

  const active = await registry.activateTarget(ACCOUNT_ID, "desktop-studio", 30)

  expect(active.lastUsedAt).toBe(30)
  expect((await registry.listTargets(ACCOUNT_ID)).map((target) => target.id)).toEqual([
    DEFAULT_STANDALONE_TARGET_ID,
    "desktop-studio",
  ])
  await expect(registry.getActiveTarget(ACCOUNT_ID)).resolves.toMatchObject({
    id: "desktop-studio",
    kind: "companion",
  })
})

it("does not allow the active target to be deleted", async () => {
  const registry = new RuntimeTargetRegistry()
  await registry.ensureDefaultActiveTarget(ACCOUNT_ID)

  await expect(registry.deleteTarget(ACCOUNT_ID, DEFAULT_STANDALONE_TARGET_ID)).rejects.toThrow(
    /active runtime target/i
  )
})

it("uses a distinct physical database name for every account and target", () => {
  expect(runtimeTargetDatabaseName("acct_alpha", "web-standalone")).toBe(
    "cognia-account-acct_alpha-target-web-standalone"
  )
  expect(runtimeTargetDatabaseName("acct_alpha", "desktop-studio")).not.toBe(
    runtimeTargetDatabaseName("acct_beta", "desktop-studio")
  )
  expect(encryptedRuntimeTargetDatabaseName("acct_alpha", "web-standalone")).toBe(
    "cognia-account-acct_alpha-target-web-standalone-encrypted-v1"
  )
})

it("fails closed for malformed Companion metadata", async () => {
  const registry = new RuntimeTargetRegistry()
  await expect(
    registry.addTarget({
      accountId: ACCOUNT_ID,
      id: "desktop-studio",
      kind: "companion",
      label: "Studio Mac",
    })
  ).rejects.toThrow(/host kind/i)
})

it("deletes every target and active pointer for a removed account", async () => {
  const registry = new RuntimeTargetRegistry()
  await registry.ensureDefaultActiveTarget(ACCOUNT_ID)
  await registry.addTarget({
    accountId: ACCOUNT_ID,
    id: "desktop-studio",
    kind: "companion",
    hostKind: "desktop",
    label: "Studio Mac",
  })

  await registry.deleteAccountTargets(ACCOUNT_ID)

  await expect(registry.listTargets(ACCOUNT_ID)).resolves.toEqual([])
  await expect(registry.getActiveTarget(ACCOUNT_ID)).resolves.toBeNull()
})

it("clears an active pointer only when explicitly deleting that active target", async () => {
  const registry = new RuntimeTargetRegistry()
  await registry.addTarget({
    accountId: "acct_mobile",
    id: "host-mobile-a",
    kind: "companion",
    hostKind: "desktop",
    label: "Host A",
  })
  await registry.activateTarget("acct_mobile", "host-mobile-a")

  await expect(registry.deleteActiveTarget("acct_mobile", "host-mobile-other")).rejects.toThrow(
    /not the active runtime target/i
  )
  await registry.deleteActiveTarget("acct_mobile", "host-mobile-a")

  await expect(registry.getActiveTarget("acct_mobile")).resolves.toBeNull()
  await expect(registry.listTargets("acct_mobile")).resolves.toEqual([])
  registry.close()
})

it("upserts public Companion metadata without storing a credential value", async () => {
  const registry = new RuntimeTargetRegistry()

  const target = await registry.upsertCompanionTarget({
    accountId: ACCOUNT_ID,
    id: "companion-studio",
    label: "studio.local",
    hostKind: "desktop",
    baseUrl: "https://studio.local:7890/path",
    deviceId: "device-1",
    serverVersion: "2.0.0",
    credentialRef: "companion-host:acct_runtime:companion-studio:device-private-jwk",
    now: 10,
  })

  expect(target).toMatchObject({
    baseUrl: "https://studio.local:7890",
    credentialRef: "companion-host:acct_runtime:companion-studio:device-private-jwk",
  })
  expect(target).not.toHaveProperty("deviceJwt")
})

it("accepts a plaintext loopback Companion endpoint with no flag at all", async () => {
  // The browser plane (`browser_access`, 27891) is plaintext by construction —
  // a tab cannot validate the Host's self-signed certificate — so demanding
  // https here made the documented topology unpairable. Worse, this guard runs
  // after the Host has already spent the one-shot invitation.
  const registry = new RuntimeTargetRegistry()

  for (const baseUrl of [
    "http://127.0.0.1:27891/path",
    "http://localhost:27891",
    "http://[::1]:27891",
  ]) {
    await expect(
      registry.upsertCompanionTarget({
        accountId: ACCOUNT_ID,
        id: "companion-dev",
        label: "Dev host",
        hostKind: "desktop" as const,
        baseUrl,
        deviceId: "device-dev",
        serverVersion: "2.0.0",
        credentialRef: "companion-host:acct_runtime:companion-dev:device-private-jwk",
      })
    ).resolves.toMatchObject({ baseUrl: new URL(baseUrl).origin })
  }
})

it("rejects plaintext Companion endpoints off this machine unless the dev flag is explicit", async () => {
  const registry = new RuntimeTargetRegistry()
  const input = {
    accountId: ACCOUNT_ID,
    id: "companion-lan",
    label: "LAN host",
    hostKind: "desktop" as const,
    baseUrl: "http://192.168.1.42:7890/path",
    deviceId: "device-lan",
    serverVersion: "2.0.0",
    credentialRef: "companion-host:acct_runtime:companion-lan:device-private-jwk",
  }

  // Cleartext credentials on a shared network stay refused; the loopback
  // exemption is about the address, not about relaxing the rule.
  await expect(registry.upsertCompanionTarget(input)).rejects.toThrow(/HTTPS/)

  process.env.NEXT_PUBLIC_ALLOW_INSECURE_COMPANION_HTTP = "1"
  await expect(registry.upsertCompanionTarget(input)).resolves.toMatchObject({
    baseUrl: "http://192.168.1.42:7890",
  })
})

it("atomically upserts and activates a completed Companion pairing", async () => {
  const registry = new RuntimeTargetRegistry()
  await registry.ensureDefaultActiveTarget(ACCOUNT_ID, 5)

  const target = await registry.upsertAndActivateCompanionTarget({
    accountId: ACCOUNT_ID,
    id: "companion-cloud",
    label: "cloud.example",
    hostKind: "cloud",
    baseUrl: "https://cloud.example/path",
    deviceId: "device-cloud",
    serverVersion: "2.0.0",
    credentialRef: "companion-host:acct_runtime:companion-cloud:device-private-jwk",
    now: 20,
  })

  expect(target).toMatchObject({
    id: "companion-cloud",
    baseUrl: "https://cloud.example",
    lastUsedAt: 20,
  })
  await expect(registry.getActiveTarget(ACCOUNT_ID)).resolves.toEqual(target)
})
