/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const pushOneMock = jest.fn()
jest.mock("@/hooks/skills", () => ({
  useSkillSync: () => ({ busy: false, push: jest.fn(), pull: jest.fn(), pushOne: pushOneMock }),
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SkillSyncSection } from "./skill-sync-section"
import type { Skill } from "@/lib/claude/types"

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "skill_1",
    name: "Test",
    content: "x",
    createdAt: 0,
    updatedAt: 0,
    source: "custom",
    ...over,
  } as Skill
}

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  pushOneMock.mockReset()
})

describe("SkillSyncSection", () => {
  it("renders 'never synced' when nativeDirectory is empty", () => {
    render(<SkillSyncSection skill={makeSkill({})} />)
    expect(screen.getByText("status.never")).toBeInTheDocument()
  })

  it("renders 'synced' when fingerprint is set and no error", () => {
    render(
      <SkillSyncSection
        skill={makeSkill({
          nativeDirectory: "/u/.claude/skills/x",
          syncFingerprint: "abc",
          lastSyncedAt: Date.now(),
        })}
      />
    )
    expect(screen.getByText("status.synced")).toBeInTheDocument()
  })

  it("renders 'out of sync' when nativeDirectory present but no fingerprint", () => {
    render(
      <SkillSyncSection
        skill={makeSkill({ nativeDirectory: "/u/.claude/skills/x", syncFingerprint: undefined })}
      />
    )
    expect(screen.getByText("status.outOfSync")).toBeInTheDocument()
  })

  it("renders error state with retry button when lastSyncError is set", () => {
    render(<SkillSyncSection skill={makeSkill({ lastSyncError: "disk full" })} />)
    expect(screen.getByText("status.error")).toBeInTheDocument()
    expect(screen.getByText("disk full")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument()
  })

  it("renders the desktop-only hint when not Tauri", () => {
    isTauriMock.mockReturnValue(false)
    render(<SkillSyncSection skill={makeSkill({})} />)
    expect(screen.getByText("desktopOnly")).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("calls pushOne with the skill id when Sync now is clicked", async () => {
    render(<SkillSyncSection skill={makeSkill({})} />)
    await userEvent.click(screen.getByRole("button", { name: /syncNow/i }))
    expect(pushOneMock).toHaveBeenCalledWith("skill_1")
  })
})
