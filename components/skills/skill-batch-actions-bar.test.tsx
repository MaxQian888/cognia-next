/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/db/skills", () => ({
  deleteSkill: jest.fn(),
  listSkillsByIds: jest.fn(async () => []),
  setSkillStatus: jest.fn(),
}))

jest.mock("@/lib/skills/export-toast", () => ({
  exportSkillsToDirWithFeedback: jest.fn(),
}))

import { render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillBatchActionsBar } from "./skill-batch-actions-bar"

beforeEach(() => {
  useSkillsStore.setState({ selection: new Set<string>() } as never)
})

describe("SkillBatchActionsBar", () => {
  it("does not render when selection is empty", () => {
    render(<SkillBatchActionsBar />)
    expect(screen.queryByTestId("skill-batch-actions-bar")).not.toBeInTheDocument()
  })

  it("renders the floating bar when selection is non-empty", () => {
    useSkillsStore.setState({ selection: new Set(["s1", "s2"]) } as never)
    render(<SkillBatchActionsBar />)
    expect(screen.getByTestId("skill-batch-actions-bar")).toBeInTheDocument()
    expect(screen.getByText('selectedCount:{"count":2}')).toBeInTheDocument()
  })

  it("exposes enable / disable / export / delete action buttons", () => {
    useSkillsStore.setState({ selection: new Set(["s1"]) } as never)
    render(<SkillBatchActionsBar />)
    expect(screen.getByText("enable")).toBeInTheDocument()
    expect(screen.getByText("disable")).toBeInTheDocument()
    expect(screen.getByText("toolbar.exportAll")).toBeInTheDocument()
    expect(screen.getByText("delete")).toBeInTheDocument()
  })
})
