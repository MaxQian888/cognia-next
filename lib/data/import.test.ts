jest.mock("./migrate", () => ({
  migrateEnvelope: jest.fn(),
}))
jest.mock("./apply-package", () => ({
  applyBackupPackage: jest.fn(),
}))

import { validateEnvelope, importEnvelope, applyBackupPackage, migrateEnvelope } from "./import"
import * as migrate from "./migrate"
import * as apply from "./apply-package"

const mockMigrate = migrate.migrateEnvelope as unknown as jest.Mock
const mockApply = apply.applyBackupPackage as unknown as jest.Mock

beforeEach(() => {
  mockMigrate.mockReset()
  mockApply.mockReset()
})

describe("validateEnvelope", () => {
  it("delegates to migrateEnvelope and returns the result", async () => {
    mockMigrate.mockResolvedValue({ ok: true })
    const out = await validateEnvelope({ raw: 1 })
    expect(mockMigrate).toHaveBeenCalledWith({ raw: 1 })
    expect(out).toEqual({ ok: true })
  })
})

describe("importEnvelope", () => {
  it("migrates then applies", async () => {
    mockMigrate.mockResolvedValue({ pkg: 1 })
    mockApply.mockResolvedValue({ summary: 1 })
    const opts = { mergeStrategy: "skip" as const, includeSessions: false, includeApiKey: false }
    const summary = await importEnvelope({ envelope: true }, opts)
    expect(mockMigrate).toHaveBeenCalledWith({ envelope: true })
    expect(mockApply).toHaveBeenCalledWith({ pkg: 1 }, opts)
    expect(summary).toEqual({ summary: 1 })
  })
})

describe("re-exports", () => {
  it("exposes applyBackupPackage and migrateEnvelope from the import facade", () => {
    expect(applyBackupPackage).toBe(apply.applyBackupPackage)
    expect(migrateEnvelope).toBe(migrate.migrateEnvelope)
  })
})
