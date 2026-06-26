/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let mockSelectedSkills: Array<{ id: string; tags?: string[] }> = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockSelectedSkills }))

const updateSkill = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/skills", () => ({
  deleteSkill: jest.fn(),
  listSkillsByIds: jest.fn(async () => []),
  setSkillStatus: jest.fn(),
  updateSkill: (...a: unknown[]) => updateSkill(...a),
}))

jest.mock("@/lib/skills/export-toast", () => ({
  exportSkillsToDirWithFeedback: jest.fn(),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}))

jest.mock("@/lib/logging", () => ({
  loggers: { skills: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } },
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { useChatStore } from "@/stores/chat"
import { deleteSkill, setSkillStatus } from "@/lib/db/skills"
import { exportSkillsToDirWithFeedback } from "@/lib/skills/export-toast"
import { SkillBatchActionsBar } from "./skill-batch-actions-bar"

beforeEach(() => {
  mockSelectedSkills = []
  updateSkill.mockClear()
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

  it("exposes enable / disable / tags / export / delete action buttons", () => {
    useSkillsStore.setState({ selection: new Set(["s1"]) } as never)
    render(<SkillBatchActionsBar />)
    expect(screen.getByText("enable")).toBeInTheDocument()
    expect(screen.getByText("disable")).toBeInTheDocument()
    expect(screen.getByText("button")).toBeInTheDocument()
    expect(screen.getByText("toolbar.exportAll")).toBeInTheDocument()
    expect(screen.getByText("delete")).toBeInTheDocument()
  })

  it("adds a tag to every selected skill via the popover", async () => {
    mockSelectedSkills = [
      { id: "s1", tags: ["x"] },
      { id: "s2", tags: [] },
    ]
    useSkillsStore.setState({ selection: new Set(["s1", "s2"]) } as never)
    render(<SkillBatchActionsBar />)
    fireEvent.click(screen.getByText("button"))
    fireEvent.change(screen.getByPlaceholderText("addPlaceholder"), { target: { value: "urgent" } })
    fireEvent.click(screen.getByText("add"))
    await waitFor(() => expect(updateSkill).toHaveBeenCalledTimes(2))
    expect(updateSkill).toHaveBeenCalledWith("s1", { tags: ["x", "urgent"] })
    expect(updateSkill).toHaveBeenCalledWith("s2", { tags: ["urgent"] })
  })

  it("batch-enables the selection", async () => {
    useSkillsStore.setState({ selection: new Set(["s1", "s2"]) } as never)
    render(<SkillBatchActionsBar />)
    fireEvent.click(screen.getByText("enable"))
    await waitFor(() => expect(setSkillStatus).toHaveBeenCalledWith("s1", "enabled"))
  })

  it("batch-disables the selection", async () => {
    useSkillsStore.setState({ selection: new Set(["s1"]) } as never)
    render(<SkillBatchActionsBar />)
    fireEvent.click(screen.getByText("disable"))
    await waitFor(() => expect(setSkillStatus).toHaveBeenCalledWith("s1", "disabled"))
  })

  it("batch-exports the selection", async () => {
    useSkillsStore.setState({ selection: new Set(["s1"]) } as never)
    render(<SkillBatchActionsBar />)
    fireEvent.click(screen.getByText("toolbar.exportAll"))
    await waitFor(() => expect(exportSkillsToDirWithFeedback).toHaveBeenCalled())
  })

  it("batch-deletes the selection and prunes those ids from ephemeral attachments", async () => {
    useSkillsStore.setState({ selection: new Set(["s1"]) } as never)
    useChatStore.getState().setEphemeralSkillIds(["s1", "keep"])
    render(<SkillBatchActionsBar />)
    fireEvent.click(screen.getByText("delete"))
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith("s1"))
    await waitFor(() => expect(useChatStore.getState().ephemeralSkillIds).toEqual(["keep"]))
  })

  it("removes an existing tag chip from the selection", async () => {
    mockSelectedSkills = [{ id: "s1", tags: ["keep", "drop"] }]
    useSkillsStore.setState({ selection: new Set(["s1"]) } as never)
    render(<SkillBatchActionsBar />)
    fireEvent.click(screen.getByText("button"))
    fireEvent.click(screen.getByLabelText('removeAria:{"tag":"drop"}'))
    await waitFor(() => expect(updateSkill).toHaveBeenCalledWith("s1", { tags: ["keep"] }))
  })
})
