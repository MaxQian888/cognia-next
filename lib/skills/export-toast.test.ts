const toastSuccess: jest.Mock = jest.fn()
const toastInfo: jest.Mock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}))
const serializeSkillsBundle: jest.Mock = jest.fn(async () => new Uint8Array([0x50, 0x4b]))
jest.mock("@/lib/skills/bundle/serializer", () => ({
  serializeSkillsBundle: (...args: unknown[]) => serializeSkillsBundle(...args),
}))
const listResourcesForSkill: jest.Mock = jest.fn(async () => [])
jest.mock("@/lib/db/skill-resources", () => ({
  listResourcesForSkill: (...args: unknown[]) => listResourcesForSkill(...args),
}))
const saveBinaryFileAs: jest.Mock = jest.fn(async () => true)
jest.mock("@/lib/files/file-bridge", () => ({
  saveBinaryFileAs: (...args: unknown[]) => saveBinaryFileAs(...args),
}))
jest.mock("@cognia/logging", () => {
  const child = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => child }
  return { loggers: { skills: child } }
})

import type { Skill } from "@cognia/agent-config-types"
import { exportSkillsToDirWithFeedback } from "./export-toast"

const mockT = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key
const baseSkill = {
  id: "skill_alpha",
  slug: "alpha",
  name: "Alpha",
  description: "Alpha skill",
  content: "Body",
  createdAt: 1,
  updatedAt: 1,
} as Skill

beforeEach(() => jest.clearAllMocks())

describe("exportSkillsToDirWithFeedback", () => {
  it("short-circuits when given an empty list", async () => {
    await expect(exportSkillsToDirWithFeedback([], mockT)).resolves.toEqual({
      ran: false,
      writtenCount: 0,
      failedCount: 0,
      total: 0,
    })
    expect(toastInfo).toHaveBeenCalledWith("noCustomToExport")
    expect(saveBinaryFileAs).not.toHaveBeenCalled()
  })

  it("exports a single complete bundle using its stable slug", async () => {
    listResourcesForSkill.mockResolvedValueOnce([{ id: "resource" }])
    await expect(exportSkillsToDirWithFeedback([baseSkill], mockT)).resolves.toMatchObject({
      ran: true,
      writtenCount: 1,
    })
    expect(serializeSkillsBundle).toHaveBeenCalledWith([
      { skill: baseSkill, resources: [{ id: "resource" }] },
    ])
    expect(saveBinaryFileAs).toHaveBeenCalledWith(
      expect.objectContaining({ defaultName: "alpha.zip", mimeType: "application/zip" })
    )
    expect(toastSuccess).toHaveBeenCalledWith('exportedCount:{"count":1}')
  })

  it("exports multiple skills into one dated archive", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-08T12:00:00Z"))
    const beta = { ...baseSkill, id: "skill_beta", slug: "beta", name: "Beta" }
    await exportSkillsToDirWithFeedback([baseSkill, beta], mockT)
    expect(saveBinaryFileAs).toHaveBeenCalledWith(
      expect.objectContaining({ defaultName: "skills-2026-08-08.zip" })
    )
    jest.useRealTimers()
  })

  it("reports cancellation without claiming files were written", async () => {
    saveBinaryFileAs.mockResolvedValueOnce(false)
    await expect(exportSkillsToDirWithFeedback([baseSkill], mockT)).resolves.toEqual({
      ran: false,
      writtenCount: 0,
      failedCount: 0,
      total: 1,
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
