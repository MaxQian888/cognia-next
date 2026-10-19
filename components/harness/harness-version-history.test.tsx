/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { makeComponents, makeSnapshot } from "@/lib/harness/test-fixtures"

let mockSnapshots: HarnessSnapshotV1[] = []
jest.mock("@/hooks/harness/use-harness-data", () => ({
  useAgentHarnessSnapshots: () => mockSnapshots,
}))
jest.mock("./harness-snapshot-diff", () => ({
  HarnessSnapshotDiff: () => <div data-testid="diff-probe" />,
}))
const mockPreview = jest.fn()
const mockRestore = jest.fn()
jest.mock("@/lib/harness/runtime/restore", () => ({
  defaultRestoreDeps: async () => ({}),
  previewHarnessRestore: (...args: unknown[]) => mockPreview(...args),
  restoreHarnessVersion: (...args: unknown[]) => mockRestore(...args),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

import { toast } from "sonner"
import { HarnessVersionHistory } from "./harness-version-history"

const current = makeSnapshot({ id: "snap-now", contentHash: "hash-now" })
const old = makeSnapshot({
  id: "snap-old",
  contentHash: "hash-old-0123456789",
  origin: { kind: "adopted", runId: "run-0", label: "agg1" },
  components: makeComponents({ memory: "old" }),
})

beforeEach(() => {
  mockSnapshots = [current, old]
  mockPreview.mockReset().mockResolvedValue({
    current,
    target: old,
    unchanged: false,
    carriedSkillIds: [],
    risk: { risk: "high", reasons: ["tool rule cap removed"] },
  })
  mockRestore
    .mockReset()
    .mockResolvedValue({ restored: makeSnapshot({ id: "snap-r" }), decisionId: "d" })
})

describe("HarnessVersionHistory", () => {
  it("lists versions with where they came from", () => {
    const onOpenRun = jest.fn()
    render(
      <HarnessVersionHistory
        characterId="agent-1"
        adoptedSnapshotId="snap-old"
        editable
        onOpenRun={onOpenRun}
      />
    )
    expect(screen.getByText("Adopted")).toBeInTheDocument()
    expect(screen.getByText("Combined harness 1")).toBeInTheDocument()
    expect(screen.getByText("In effect")).toBeInTheDocument()
    expect(screen.getByText("hash-old-0")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Open run"))
    expect(onOpenRun).toHaveBeenCalledWith("run-0")
  })

  it("previews a restore with its risk and restores against the reviewed harness", async () => {
    render(<HarnessVersionHistory characterId="agent-1" editable />)
    fireEvent.click(screen.getByTestId("harness-version-open-snap-old"))
    await waitFor(() => expect(screen.getByText("High risk")).toBeInTheDocument())
    expect(mockPreview).toHaveBeenCalledWith("agent-1", "snap-old", {})
    expect(screen.getByText("tool rule cap removed")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("harness-version-restore"))
    await waitFor(() =>
      expect(mockRestore).toHaveBeenCalledWith(
        { characterId: "agent-1", snapshotId: "snap-old", expectedContentHash: "hash-now" },
        {}
      )
    )
    expect(toast.success).toHaveBeenCalledWith("Version restored.")
  })

  it("will not restore onto an agent it cannot write, or the same harness", async () => {
    mockPreview.mockResolvedValueOnce({
      current,
      target: current,
      unchanged: true,
      carriedSkillIds: [],
      risk: { risk: "low", reasons: ["no change"] },
    })
    render(<HarnessVersionHistory characterId="agent-1" editable={false} />)
    fireEvent.click(screen.getByTestId("harness-version-open-snap-now"))
    await waitFor(() =>
      expect(screen.getByText(/already has exactly this harness/)).toBeInTheDocument()
    )
    expect(screen.getByTestId("harness-version-restore")).toBeDisabled()
  })

  it("explains a refused restore in the person's language", async () => {
    mockRestore.mockRejectedValue(
      Object.assign(new Error("x"), { name: "HarnessRestoreError", code: "agent-changed" })
    )
    render(<HarnessVersionHistory characterId="agent-1" editable />)
    fireEvent.click(screen.getByTestId("harness-version-open-snap-old"))
    await waitFor(() => expect(screen.getByTestId("harness-version-restore")).toBeEnabled())
    fireEvent.click(screen.getByTestId("harness-version-restore"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not restore this version.", {
        description:
          "The agent changed after you opened this version. Review the difference again.",
      })
    )
  })

  it("says when nothing was recorded", () => {
    mockSnapshots = []
    render(<HarnessVersionHistory characterId="agent-1" editable />)
    expect(screen.getByTestId("harness-versions-empty")).toBeInTheDocument()
  })
})
