/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { ConnectorQueueDetail } from "./connector-queue-detail"

const useLiveQuery = jest.fn()
const mockRuns: UnifiedExecutionRun[] = []

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQuery(...args),
}))
jest.mock("@/hooks/scheduler/use-unified-recent-runs", () => ({
  useUnifiedRecentRuns: () => ({ runs: mockRuns }),
}))

describe("ConnectorQueueDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRuns.length = 0
  })

  it("renders queue state and keeps recent dispatch selection", () => {
    useLiveQuery.mockReturnValueOnce(3).mockReturnValueOnce({})
    const run = {
      unifiedId: "connector:run-1",
      kind: "connector",
      itemName: "Daily digest",
      status: "succeeded",
      startedAt: "2026-08-10T01:00:00.000Z",
      origin: { nativeId: "run-1" },
    } as UnifiedExecutionRun
    mockRuns.push(run)
    const onSelectRun = jest.fn()

    render(<ConnectorQueueDetail onSelectRun={onSelectRun} />)

    expect(screen.getByText("3")).toBeInTheDocument()
    const row = screen.getByRole("button", { name: /Daily digest/ })
    expect(row).toHaveAttribute("data-slot", "button")
    fireEvent.click(row)
    expect(onSelectRun).toHaveBeenCalledWith(run)
  })
})
