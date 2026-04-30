const toastSuccess = jest.fn()
const toastInfo = jest.fn()
const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
  },
}))
jest.mock("@/lib/claude/skills-io", () => ({
  serializeSkill: jest.fn(() => "MD"),
  skillFilename: jest.fn((name: string) => `${name}.skill.md`),
}))
jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: jest.fn(),
  saveFilesToDir: jest.fn(),
}))
jest.mock("@/lib/logger", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    loggers: {
      skills: child,
    },
  }
})

import { exportSkillsToDirWithFeedback } from "./export-toast"
import { pickDirectory, saveFilesToDir } from "@/lib/files/file-bridge"
import { loggers } from "@/lib/logger"
import type { Skill } from "@/lib/claude/types"

const mockedPick = pickDirectory as unknown as jest.Mock
const mockedSave = saveFilesToDir as unknown as jest.Mock
const mockT = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key

beforeEach(() => {
  jest.clearAllMocks()
})

describe("exportSkillsToDirWithFeedback", () => {
  it("short-circuits when given an empty list", async () => {
    const out = await exportSkillsToDirWithFeedback([], mockT)
    expect(out).toEqual({ ran: false, writtenCount: 0, failedCount: 0, total: 0 })
    expect(toastInfo).toHaveBeenCalledWith("noCustomToExport")
    expect(loggers.skills.info).toHaveBeenCalled()
    expect(mockedPick).not.toHaveBeenCalled()
  })

  it("writes every skill and toasts a success when none failed", async () => {
    mockedPick.mockResolvedValue("/dst")
    mockedSave.mockResolvedValue({ writtenCount: 2, errored: [] })
    const skills = [{ name: "alpha" } as unknown as Skill, { name: "beta" } as unknown as Skill]
    const out = await exportSkillsToDirWithFeedback(skills, mockT, { source: "test" })
    expect(mockedSave).toHaveBeenCalledWith("/dst", [
      { name: "alpha.skill.md", content: "MD" },
      { name: "beta.skill.md", content: "MD" },
    ])
    expect(toastSuccess).toHaveBeenCalledWith('exportedCount:{"count":2}')
    expect(out).toEqual({ ran: true, writtenCount: 2, failedCount: 0, total: 2 })
  })

  it("toasts a partial-export warning when some files errored", async () => {
    mockedPick.mockResolvedValue(null)
    mockedSave.mockResolvedValue({
      writtenCount: 1,
      errored: [{ name: "x", error: "fail" }],
    })
    const skills = [{ name: "alpha" } as unknown as Skill, { name: "beta" } as unknown as Skill]
    const out = await exportSkillsToDirWithFeedback(skills, mockT)
    expect(toastWarning).toHaveBeenCalled()
    expect(loggers.skills.warn).toHaveBeenCalled()
    expect(out.ran).toBe(true)
    expect(out.writtenCount).toBe(1)
    expect(out.failedCount).toBe(1)
  })
})
