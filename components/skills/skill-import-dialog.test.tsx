/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/db/skills", () => ({
  bulkImportSkills: jest.fn(async () => ({
    created: 1,
    updated: 0,
    skipped: 0,
    errored: [],
  })),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillImportDialog } from "./skill-import-dialog"
import type { ImportStaging } from "@/stores/skills"

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
})
