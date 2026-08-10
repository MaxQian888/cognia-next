/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { WorkflowDetail } from "./workflow-detail"

const useLiveQuery = jest.fn()
const mockRuns: UnifiedExecutionRun[] = []

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQuery(...args),
}))
jest.mock("@/hooks/scheduler/use-unified-recent-runs", () => ({
  useUnifiedRecentRuns: () => ({ runs: mockRuns }),
}))

describe("WorkflowDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRuns.length = 0
  })

  it("keeps workflow navigation and run selection intact", () => {
    useLiveQuery
      .mockReturnValueOnce({
        workflowId: "workflow-1",
        kind: "cron",
        cron: "0 9 * * *",
        enabled: true,
      })
      .mockReturnValueOnce({ name: "Morning workflow" })
    const run = {
      unifiedId: "workflow:run-1",
      kind: "workflow",
      itemName: "Morning workflow",
      status: "succeeded",
      startedAt: "2026-08-10T01:00:00.000Z",
      origin: { nativeId: "run-1" },
    } as UnifiedExecutionRun
    mockRuns.push(run)
    const onSelectRun = jest.fn()

    render(<WorkflowDetail workflowTriggerId="trigger-1" onSelectRun={onSelectRun} />)

    expect(screen.getByRole("link", { name: /openInWorkflowEditor/ })).toHaveAttribute(
      "href",
      "/workflows/editor?id=workflow-1"
    )
    const row = screen.getByTestId("workflow-run-run-1")
    expect(row).toHaveAttribute("data-slot", "button")
    fireEvent.click(row)
    expect(onSelectRun).toHaveBeenCalledWith(run)
  })
})
