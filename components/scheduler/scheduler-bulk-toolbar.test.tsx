/** @jest-environment jsdom */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { SchedulerBulkToolbar } from "./scheduler-bulk-toolbar"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  // The failure list is joined with `Intl.ListFormat`, which needs a locale.
  useLocale: () => "en",
}))

// Stub AlertDialog so we don't need its full Radix machinery.
jest.mock("@/components/ui/alert-dialog")

const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastErrorMock(...a) } }))

function makeItem(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:t-1",
    kind: "app",
    sourceId: "t-1",
    name: "T",
    status: "active",
    triggerSummary: { type: "cron", cron: "0 9 * * *" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

function fakeRegistry(calls: { action: string; kind: string; sourceId: string }[]) {
  return {
    register: jest.fn(),
    unregister: jest.fn(),
    getSource: jest.fn((kind: string) => ({
      pause: jest.fn(async (sourceId: string) => {
        calls.push({ action: "pause", kind, sourceId })
      }),
      resume: jest.fn(async (sourceId: string) => {
        calls.push({ action: "resume", kind, sourceId })
      }),
      delete: jest.fn(async (sourceId: string) => {
        calls.push({ action: "delete", kind, sourceId })
      }),
    })),
    listAllSources: jest.fn(),
    has: jest.fn(),
  } as unknown as ReturnType<
    typeof import("@/lib/scheduler/sources/registry").getSchedulerSourceRegistry
  >
}

describe("SchedulerBulkToolbar", () => {
  it("renders nothing when there is no selection", () => {
    const { container } = render(
      <SchedulerBulkToolbar selectedItems={[]} onClearSelection={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the selection count and the three bulk actions", () => {
    render(
      <SchedulerBulkToolbar
        selectedItems={[makeItem({ unifiedId: "a:1" }), makeItem({ unifiedId: "a:2" })]}
        onClearSelection={() => {}}
      />
    )
    expect(screen.getByTestId("scheduler-bulk-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("bulk-count-value")).toHaveTextContent("2")
    expect(screen.getByTestId("bulk-pause")).toBeInTheDocument()
    expect(screen.getByTestId("bulk-resume")).toBeInTheDocument()
    expect(screen.getByTestId("bulk-delete")).toBeInTheDocument()
  })

  it("dispatches pause to each selected item's source and then clears the selection", async () => {
    const calls: { action: string; kind: string; sourceId: string }[] = []
    const onClear = jest.fn()
    render(
      <SchedulerBulkToolbar
        selectedItems={[
          makeItem({ unifiedId: "app:1", kind: "app", sourceId: "1" }),
          makeItem({ unifiedId: "workflow:2", kind: "workflow", sourceId: "2" }),
        ]}
        onClearSelection={onClear}
        registry={fakeRegistry(calls)}
      />
    )
    fireEvent.click(screen.getByTestId("bulk-pause"))
    await waitFor(() => expect(onClear).toHaveBeenCalled())
    expect(calls).toEqual([
      { action: "pause", kind: "app", sourceId: "1" },
      { action: "pause", kind: "workflow", sourceId: "2" },
    ])
  })

  it("skips items whose capabilities forbid the action", async () => {
    const calls: { action: string; kind: string; sourceId: string }[] = []
    render(
      <SchedulerBulkToolbar
        selectedItems={[
          makeItem({
            unifiedId: "connector:queue",
            kind: "connector",
            sourceId: "queue",
            capabilities: { runNow: false, pause: false, edit: false, delete: false },
          }),
          makeItem({ unifiedId: "app:1", kind: "app", sourceId: "1" }),
        ]}
        onClearSelection={() => {}}
        registry={fakeRegistry(calls)}
      />
    )
    fireEvent.click(screen.getByTestId("bulk-pause"))
    await waitFor(() => expect(calls).toEqual([{ action: "pause", kind: "app", sourceId: "1" }]))
  })

  it("delete is confirm-gated — the AlertDialog has to be acknowledged before dispatch", async () => {
    const calls: { action: string; kind: string; sourceId: string }[] = []
    render(
      <SchedulerBulkToolbar
        selectedItems={[makeItem({ unifiedId: "app:1", kind: "app", sourceId: "1" })]}
        onClearSelection={() => {}}
        registry={fakeRegistry(calls)}
      />
    )
    fireEvent.click(screen.getByTestId("bulk-delete"))
    expect(calls).toEqual([])
    fireEvent.click(screen.getByTestId("bulk-delete-confirm"))
    await waitFor(() => expect(calls).toEqual([{ action: "delete", kind: "app", sourceId: "1" }]))
  })

  it("fires onClearSelection from the clear button", () => {
    const onClear = jest.fn()
    render(
      <SchedulerBulkToolbar
        selectedItems={[makeItem({ unifiedId: "app:1" })]}
        onClearSelection={onClear}
      />
    )
    fireEvent.click(screen.getByTestId("bulk-clear"))
    expect(onClear).toHaveBeenCalled()
  })

  it("disables bulk pause/resume when no selected item supports pause", () => {
    render(
      <SchedulerBulkToolbar
        selectedItems={[
          makeItem({
            unifiedId: "connector:queue",
            capabilities: { runNow: false, pause: false, edit: false, delete: false },
          }),
        ]}
        onClearSelection={() => {}}
      />
    )
    expect(screen.getByTestId("bulk-pause")).toBeDisabled()
    expect(screen.getByTestId("bulk-resume")).toBeDisabled()
    expect(screen.getByTestId("bulk-delete")).toBeDisabled()
  })
})

describe("SchedulerBulkToolbar · failures are reported", () => {
  it("tells the user which items a bulk pause could not update", async () => {
    const registry = {
      register: jest.fn(),
      unregister: jest.fn(),
      listAllSources: jest.fn(() => []),
      getSource: jest.fn(() => ({
        pause: jest.fn(async (sourceId: string) => {
          if (sourceId === "bad") throw new Error("host unreachable")
        }),
        resume: jest.fn(),
        delete: jest.fn(),
      })),
    } as never

    render(
      <SchedulerBulkToolbar
        selectedItems={[
          makeItem({ unifiedId: "app:ok", sourceId: "ok", name: "Good" }),
          makeItem({ unifiedId: "app:bad", sourceId: "bad", name: "Bad" }),
        ]}
        onClearSelection={jest.fn()}
        registry={registry}
      />
    )

    fireEvent.click(screen.getByTestId("bulk-pause"))
    // Before this the catch was empty and the selection just cleared, so a
    // pause that never happened looked identical to one that did.
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(toastErrorMock.mock.calls[0][0]).toBe("bulkPartialFailure")
    expect(toastErrorMock.mock.calls[0][1]).toEqual(expect.objectContaining({ description: "Bad" }))
  })
})
