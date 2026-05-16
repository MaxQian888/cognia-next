/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

jest.mock("@/hooks/skills", () => ({
  useSkillSync: () => ({ busy: false, push: jest.fn(), pull: jest.fn(), pushOne: jest.fn() }),
}))

jest.mock("@/lib/db/skills", () => ({
  listSkills: jest.fn(async () => []),
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickAndReadFiles: jest.fn(async () => []),
}))

jest.mock("@/lib/claude/skills-io", () => ({
  parseSkillMarkdown: jest.fn(),
  nameFromFilename: (s: string) => s,
}))

jest.mock("@/lib/claude/ipc", () => ({
  scanClaudeSkills: jest.fn(async () => []),
}))

jest.mock("@/lib/skills/export-toast", () => ({
  exportSkillsToDirWithFeedback: jest.fn(),
}))

import { render, screen } from "@testing-library/react"
import { SkillPanelToolbar } from "./skill-panel-toolbar"

describe("SkillPanelToolbar", () => {
  it("renders the 'New' and 'Import' triggers with localized labels", () => {
    render(<SkillPanelToolbar />)
    expect(screen.getByText("new")).toBeInTheDocument()
    expect(screen.getByText("import")).toBeInTheDocument()
  })

  it("collapses export + sync into a More-actions menu trigger at narrow widths", () => {
    render(<SkillPanelToolbar />)
    // The aria-labeled overflow trigger is mounted alongside the inline buttons; both share
    // the underlying actions so we just confirm the trigger exists and uses the localized label.
    expect(screen.getByLabelText("moreActions")).toBeInTheDocument()
  })
})
