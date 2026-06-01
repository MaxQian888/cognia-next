/**
 * Tests for the Backup Plugin API (`ctx.backup`).
 *
 * Critically asserts the API-key safety boundary: `includeApiKey` is forced
 * to false on both create and restore, regardless of caller input.
 */

import { createBackupAPI } from "./backup-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

const buildExportEnvelope = jest.fn(async (..._a: unknown[]) => ({ version: 3, payload: {} }))
const serializePackage = jest.fn((..._a: unknown[]) => "{json}")
jest.mock("@/lib/data/export", () => ({
  buildExportEnvelope: (...a: unknown[]) => buildExportEnvelope(...a),
  serializePackage: (...a: unknown[]) => serializePackage(...a),
}))

const validateEnvelope = jest.fn(async (..._a: unknown[]) => ({ version: 3 }))
const importEnvelope = jest.fn(async (..._a: unknown[]) => ({ applied: true }))
jest.mock("@/lib/data/import", () => ({
  validateEnvelope: (...a: unknown[]) => validateEnvelope(...a),
  importEnvelope: (...a: unknown[]) => importEnvelope(...a),
}))

const listBackupHistory = jest.fn(async (..._a: unknown[]) => [{ id: "h1" }])
const getLatestSuccessful = jest.fn(async (..._a: unknown[]) => ({ id: "h1" }))
jest.mock("@/lib/db/backup-history", () => ({
  listBackupHistory: (...a: unknown[]) => listBackupHistory(...a),
  getLatestSuccessful: (...a: unknown[]) => getLatestSuccessful(...a),
}))

const PLUGIN = "backup-plugin"

describe("createBackupAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    resetPermissionGuard()
    guard = getPermissionGuard()
  })

  describe("permission gating", () => {
    it("create needs backup:read", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createBackupAPI(PLUGIN)
      expect(() => api.create()).toThrow(PermissionError)
    })

    it("restore needs backup:write (read alone insufficient)", () => {
      guard.registerPlugin(PLUGIN, ["backup:read"])
      const api = createBackupAPI(PLUGIN)
      expect(() => api.listHistory()).not.toThrow()
      expect(() => api.restore({}, { mergeStrategy: "replace" } as never)).toThrow(PermissionError)
      expect(importEnvelope).not.toHaveBeenCalled()
    })
  })

  describe("api-key safety", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["backup:read", "backup:write"]))

    it("forces includeApiKey:false on create", async () => {
      const api = createBackupAPI(PLUGIN)
      await api.create({ includeSessions: true })
      expect(buildExportEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ includeApiKey: false, includeSessions: true })
      )
    })

    it("forces includeApiKey:false on restore", async () => {
      const api = createBackupAPI(PLUGIN)
      await api.restore({ env: 1 }, { mergeStrategy: "merge", includeSessions: true } as never)
      expect(importEnvelope).toHaveBeenCalledWith(
        { env: 1 },
        expect.objectContaining({
          includeApiKey: false,
          mergeStrategy: "merge",
          includeSessions: true,
        })
      )
    })
  })

  describe("read forwarding", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["backup:read"]))

    it("serialize / validate / listHistory / getLatestSuccessful forward", async () => {
      const api = createBackupAPI(PLUGIN)
      expect(api.serialize({ version: 3 } as never)).toBe("{json}")
      expect(await api.validate({ raw: 1 })).toEqual({ version: 3 })
      expect(validateEnvelope).toHaveBeenCalledWith({ raw: 1 })
      expect(await api.listHistory({ limit: 5 })).toHaveLength(1)
      expect(listBackupHistory).toHaveBeenCalledWith({ limit: 5 })
      expect(await api.getLatestSuccessful()).toEqual({ id: "h1" })
    })

    it("getLatestSuccessful maps undefined to null", async () => {
      getLatestSuccessful.mockResolvedValueOnce(undefined as never)
      const api = createBackupAPI(PLUGIN)
      expect(await api.getLatestSuccessful()).toBeNull()
    })
  })
})
