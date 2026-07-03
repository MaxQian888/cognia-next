/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const bulkImportSkills = jest.fn(async (_drafts: unknown, _strategy?: unknown) => ({
  created: 1,
  updated: 0,
  skipped: 0,
  errored: [] as unknown[],
}))
jest.mock("@/lib/db/skills", () => ({
  bulkImportSkills: (...args: unknown[]) => bulkImportSkills(...(args as [unknown, unknown?])),
  getSkill: jest.fn(),
}))

const autoEnableRef = { current: true }
jest.mock("@/hooks/skills", () => ({
  useSkillSync: () => ({ pushOne: jest.fn(), busy: false }),
  useSkillPanelPrefs: () => ({ autoEnableNew: autoEnableRef.current }),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SkillImportDialog } from "./skill-import-dialog"
import type { ImportStaging } from "@/stores/skills"

beforeEach(() => {
  autoEnableRef.current = true
  bulkImportSkills.mockClear()
})

const staging: ImportStaging = {
  drafts: [
    { name: "alpha", content: "...", tags: ["a"] },
    { name: "beta", content: "..." },
  ],
  sourceLabel: "test sources",
  parseErrors: [],
}

describe("SkillImportDialog", () => {
  it("renders the title and the staged-count badge using i18n keys", () => {
    render(<SkillImportDialog staging={staging} onCancel={jest.fn()} onComplete={jest.fn()} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText('stagedCount:{"count":2}')).toBeInTheDocument()
  })

  it("offers all three conflict strategy options", () => {
    render(<SkillImportDialog staging={staging} onCancel={jest.fn()} onComplete={jest.fn()} />)
    expect(screen.getByText("strategySkip")).toBeInTheDocument()
    expect(screen.getByText("strategyDuplicate")).toBeInTheDocument()
    expect(screen.getByText("strategyOverwrite")).toBeInTheDocument()
  })

  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = jest.fn()
    render(<SkillImportDialog staging={staging} onCancel={onCancel} onComplete={jest.fn()} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onCancel).toHaveBeenCalled()
  })

  it("imports with an undefined status (defaults to enabled) when auto-enable is on", async () => {
    render(<SkillImportDialog staging={staging} onCancel={jest.fn()} onComplete={jest.fn()} />)
    fireEvent.click(screen.getByText("apply"))
    await waitFor(() => expect(bulkImportSkills).toHaveBeenCalled())
    const drafts = bulkImportSkills.mock.calls[0][0] as Array<{ status?: string }>
    expect(drafts.every((d) => d.status === undefined)).toBe(true)
  })

  it("imports skills disabled when auto-enable is off", async () => {
    autoEnableRef.current = false
    render(<SkillImportDialog staging={staging} onCancel={jest.fn()} onComplete={jest.fn()} />)
    fireEvent.click(screen.getByText("apply"))
    await waitFor(() => expect(bulkImportSkills).toHaveBeenCalled())
    const drafts = bulkImportSkills.mock.calls[0][0] as Array<{ status?: string }>
    expect(drafts.every((d) => d.status === "disabled")).toBe(true)
  })
})
