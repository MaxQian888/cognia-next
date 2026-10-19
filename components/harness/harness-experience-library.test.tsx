/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { HarnessExperience } from "@/types/harness/experience"
import { makeExperience } from "@/lib/harness/test-fixtures"

let mockExperiences: HarnessExperience[] = []
const mockQuery = jest.fn()
jest.mock("@/hooks/harness/use-harness-data", () => ({
  useHarnessExperiences: (options: unknown) => {
    mockQuery(options)
    return mockExperiences
  },
}))
const mockUpdate = jest.fn()
const mockDelete = jest.fn()
jest.mock("@/lib/db/harness-evolution", () => ({
  updateHarnessExperience: (id: string, patch: (e: HarnessExperience) => HarnessExperience) =>
    mockUpdate(id, patch),
  deleteHarnessExperience: (id: string) => mockDelete(id),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

import { toast } from "sonner"
import { HarnessExperienceLibrary } from "./harness-experience-library"

beforeEach(() => {
  mockExperiences = [
    makeExperience({ id: "e1", validationStatus: "verified", helpedCount: 2, retrievedCount: 3 }),
    makeExperience({
      id: "e2",
      lesson: "Cap Bash at 20 calls",
      validationStatus: "deprecated",
      conflictsWith: ["e1"],
    }),
  ]
  mockQuery.mockReset()
  mockUpdate.mockReset().mockResolvedValue(undefined)
  mockDelete.mockReset().mockResolvedValue(undefined)
})

describe("HarnessExperienceLibrary", () => {
  it("lists one agent's lessons and filters them by status", () => {
    render(<HarnessExperienceLibrary characterId="agent-1" />)
    expect(mockQuery).toHaveBeenCalledWith({ characterId: "agent-1" })
    expect(screen.getByText(/Retrieved 3 · helped 2 · hurt 0/)).toBeInTheDocument()
    expect(screen.getByText(/1 conflict/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Filter lessons by status"), {
      target: { value: "deprecated" },
    })
    expect(screen.queryByTestId("harness-experience-e1")).not.toBeInTheDocument()
    expect(screen.getByTestId("harness-experience-e2")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Filter lessons by status"), {
      target: { value: "rejected" },
    })
    expect(screen.getByTestId("harness-experience-empty")).toBeInTheDocument()
  })

  it("opens a focused lesson and lets a person retire, switch off or delete it", async () => {
    const onOpenRun = jest.fn()
    render(<HarnessExperienceLibrary focusId="e1" onOpenRun={onOpenRun} />)
    expect(screen.getByText(/Applies when: csv input/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("harness-experience-retire"))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const retire = mockUpdate.mock.calls[0][1] as (e: HarnessExperience) => HarnessExperience
    expect(retire(mockExperiences[0]).validationStatus).toBe("deprecated")
    fireEvent.click(screen.getByRole("switch", { name: "Use in new runs" }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2))
    const off = mockUpdate.mock.calls[1][1] as (e: HarnessExperience) => HarnessExperience
    expect(off(mockExperiences[0]).disabled).toBe(true)
    fireEvent.click(screen.getByText("Open source run"))
    expect(onOpenRun).toHaveBeenCalledWith("run-0")
    fireEvent.click(screen.getByTestId("harness-experience-delete"))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("e1"))
  })

  it("reinstates a retired lesson and reports failed writes", async () => {
    mockUpdate.mockRejectedValue(new Error("db closed"))
    render(<HarnessExperienceLibrary />)
    fireEvent.click(screen.getByText("Cap Bash at 20 calls"))
    fireEvent.click(screen.getByText("Reinstate"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not update the lesson.", {
        description: "db closed",
      })
    )
    const reinstate = mockUpdate.mock.calls[0][1] as (e: HarnessExperience) => HarnessExperience
    expect(reinstate(mockExperiences[1]).validationStatus).toBe("proposed")
  })
})
