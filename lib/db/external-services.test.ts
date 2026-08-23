/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "./schema"
import {
  getOpenApiImport,
  invalidateCapabilityGrants,
  listCapabilityGrants,
  listServiceConnections,
  putCapabilityGrant,
  putOpenApiImport,
  putServiceConnection,
  removePluginExternalServiceState,
  resumePluginServiceConnections,
  suspendPluginServiceConnections,
} from "./external-services"
import type { CapabilityGrant, ServiceConnection } from "@/types/external-service"

jest.setTimeout(30_000)

const connection = (overrides: Partial<ServiceConnection> = {}): ServiceConnection => ({
  id: "connection-1",
  pluginId: "plugin-1",
  serviceId: "figma",
  providerId: "desktop-mcp",
  runtimeTargetId: "local",
  status: "connected",
  providerFingerprint: "fingerprint-1",
  providerRef: { kind: "mcp", serverId: "server-1" },
  enabledSurfaces: ["chat", "workflow"],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  ...overrides,
})

const grant = (overrides: Partial<CapabilityGrant> = {}): CapabilityGrant => ({
  id: "grant-1",
  connectionId: "connection-1",
  providerFingerprint: "fingerprint-1",
  operationPatterns: ["figma.read_*"],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  ...overrides,
})

describe("external service persistence", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await getDb().open()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("persists connections and restores the pre-suspend state", async () => {
    await putServiceConnection(connection())
    expect(await suspendPluginServiceConnections("plugin-1")).toBe(1)
    expect((await listServiceConnections({ pluginId: "plugin-1" }))[0]).toMatchObject({
      status: "suspended",
      suspendedFromStatus: "connected",
    })
    expect(await resumePluginServiceConnections("plugin-1")).toBe(1)
    expect((await listServiceConnections({ pluginId: "plugin-1" }))[0].status).toBe("connected")
  })

  it("rejects stale fingerprints and filters expired grants", async () => {
    await putServiceConnection(connection())
    await expect(putCapabilityGrant(grant({ providerFingerprint: "stale" }))).rejects.toThrow(
      /fingerprint/
    )
    await putCapabilityGrant(grant())
    await putCapabilityGrant(grant({ id: "expired", expiresAt: "2026-01-01T00:00:00.000Z" }))
    expect(await listCapabilityGrants("connection-1", { now: "2026-08-23T00:00:00.000Z" })).toEqual(
      [expect.objectContaining({ id: "grant-1" })]
    )
    expect(await invalidateCapabilityGrants("connection-1", "fingerprint-2")).toBe(2)
  })

  it("persists reviewed OpenAPI imports and atomically removes plugin control-plane state", async () => {
    await putServiceConnection(connection())
    await putCapabilityGrant(grant())
    await getDb().mcpCapabilityCache.put({
      id: "cache-1",
      serverId: "server-1",
      fingerprint: "fp",
      tools: [],
      resources: [],
      prompts: [],
      expiresAt: Date.now() + 1000,
      updatedAt: Date.now(),
    })
    await putOpenApiImport({
      id: "openapi-1",
      pluginId: "plugin-1",
      serviceId: "figma",
      providerId: "rest",
      label: "Figma REST",
      sourceKind: "plugin",
      document: '{"openapi":"3.1.0"}',
      documentFingerprint: "spec-fp",
      approvedOrigins: ["https://api.figma.com"],
      approvedExternalRefOrigins: [],
      trust: "trusted",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    })
    expect(await getOpenApiImport("openapi-1")).toBeDefined()

    await expect(removePluginExternalServiceState("plugin-1")).resolves.toMatchObject({
      connectionIds: ["connection-1"],
      mcpServerIds: ["server-1"],
      openApiImportIds: ["openapi-1"],
    })
    expect(await getDb().serviceConnections.count()).toBe(0)
    expect(await getDb().capabilityGrants.count()).toBe(0)
    expect(await getDb().openApiImports.count()).toBe(0)
    expect(await getDb().mcpCapabilityCache.count()).toBe(0)
  })
})
