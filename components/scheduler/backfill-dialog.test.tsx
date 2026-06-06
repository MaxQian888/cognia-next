/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, _values?: Record<string, unknown>) => key,
}))

import { BackfillDialog } from "./backfill-dialog"
import type { ScheduledTask } from "@/types/scheduler"

function buildTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "bf-1",
    name: "Backfill Task",
    type: "custom",
    trigger: { type: "interval", intervalMs: 3_600_000 },
    config: { timeout: 1000, maxRetries: 0, retryDelay: 100, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: false, onError: false },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date("2026-01-01T00:00:00"),
    updatedAt: new Date("2026-01-01T00:00:00"),
    ...overrides,
  }
}

describe("BackfillDialog", () => {
  const onOpenChange = jest.fn()

  beforeEach(() => jest.clearAllMocks())

  it("previews the slot count for a valid past range", () => {
    render(
      <BackfillDialog
        open
        onOpenChange={onOpenChange}
        task={buildTask()}
        onBackfill={jest.fn(async () => 0)}
      />
    )

    fireEvent.change(screen.getByTestId("backfill-start-date"), {
      target: { value: "2026-02-01" },
    })
    fireEvent.change(screen.getByTestId("backfill-end-date"), {
      target: { value: "2026-02-01" },
    })

    // Hourly interval over one day → preview text rendered (mock t returns key).
    expect(screen.getByTestId("backfill-preview")).toHaveTextContent("backfill.slotCount")
  })

  it("rejects an inverted range", () => {
    render(
      <BackfillDialog
        open
        onOpenChange={onOpenChange}
        task={buildTask()}
        onBackfill={jest.fn(async () => 0)}
      />
    )

    fireEvent.change(screen.getByTestId("backfill-start-date"), {
      target: { value: "2026-03-01" },
    })
    fireEvent.change(screen.getByTestId("backfill-end-date"), {
      target: { value: "2026-02-01" },
    })

    expect(screen.getByTestId("backfill-validation")).toHaveTextContent("backfill.rangeInvalid")
    expect(screen.getByTestId("backfill-confirm")).toBeDisabled()
  })

  it("rejects a range ending in the future", () => {
    render(
      <BackfillDialog
        open
        onOpenChange={onOpenChange}
        task={buildTask()}
        onBackfill={jest.fn(async () => 0)}
      />
    )

    const future = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    fireEvent.change(screen.getByTestId("backfill-start-date"), {
      target: { value: "2026-02-01" },
    })
    fireEvent.change(screen.getByTestId("backfill-end-date"), {
      target: { value: future },
    })

    expect(screen.getByTestId("backfill-validation")).toHaveTextContent("backfill.endMustBePast")
  })

  it("shows the unsupported notice for non-recurring tasks", () => {
    render(
      <BackfillDialog
        open
        onOpenChange={onOpenChange}
        task={buildTask({ trigger: { type: "event", eventType: "custom" } })}
        onBackfill={jest.fn(async () => 0)}
      />
    )
    expect(screen.getByTestId("backfill-validation")).toHaveTextContent(
      "backfill.unsupportedTrigger"
    )
  })

  it("runs the backfill and reports success", async () => {
    const onBackfill = jest.fn(async () => 24)
    render(
      <BackfillDialog open onOpenChange={onOpenChange} task={buildTask()} onBackfill={onBackfill} />
    )

    fireEvent.change(screen.getByTestId("backfill-start-date"), {
      target: { value: "2026-02-01" },
    })
    fireEvent.change(screen.getByTestId("backfill-end-date"), {
      target: { value: "2026-02-01" },
    })
    fireEvent.click(screen.getByTestId("backfill-confirm"))

    await waitFor(() => expect(screen.getByTestId("backfill-result")).toBeInTheDocument())
    expect(onBackfill).toHaveBeenCalledWith({ start: expect.any(Date), end: expect.any(Date) })
    expect(screen.getByTestId("backfill-result")).toHaveTextContent("backfill.success")
  })

  it("surfaces backfill errors", async () => {
    const onBackfill = jest.fn(async () => {
      throw new Error("boom")
    })
    render(
      <BackfillDialog open onOpenChange={onOpenChange} task={buildTask()} onBackfill={onBackfill} />
    )

    fireEvent.change(screen.getByTestId("backfill-start-date"), {
      target: { value: "2026-02-01" },
    })
    fireEvent.change(screen.getByTestId("backfill-end-date"), {
      target: { value: "2026-02-01" },
    })
    fireEvent.click(screen.getByTestId("backfill-confirm"))

    await waitFor(() =>
      expect(screen.getByTestId("backfill-result")).toHaveTextContent("backfill.error")
    )
  })
})
