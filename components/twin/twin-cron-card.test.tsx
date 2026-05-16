/**
 * @jest-environment jsdom
 *
 * Coverage for the per-twin cron card: toggle, schedule input, preset
 * picker. The Dexie wiring is mocked at the module boundary so the test
 * does not depend on the (currently-missing) `twins` table in the fake-
 * indexeddb schema.
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

const updateTwinMock = jest.fn()
const syncCronMock = jest.fn(async (..._args: unknown[]) => ({ invalidExpressions: [] }))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T,>(_query: () => Promise<T> | T, _deps?: unknown[], initial?: T): T =>
    initial as T,
}))

jest.mock("@/lib/db/twins", () => ({
  getTwin: jest.fn(async () => undefined),
  updateTwin: (...args: unknown[]) => updateTwinMock(...args),
}))

jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: {
    getTask: jest.fn(async () => null),
  },
}))

jest.mock("@/lib/twin/cron/cron-bridge", () => ({
  CRON_PRESETS: [
    { value: "0 */6 * * *", label: "Every 6 hours" },
    { value: "0 0 * * *", label: "Daily at midnight" },
  ],
  syncTwinCronToScheduler: (...args: unknown[]) => syncCronMock(...args),
}))

// Stub Radix Select with a native <select> for accessibility-friendly testing.
// We bubble aria-label + data-testid up from SelectTrigger onto the rendered
// native <select> so existing test queries (getByTestId, getByLabelText) still
// work without spelunking the radix portal.
jest.mock("@/components/ui/select", () => {
  type Harvest = {
    ariaLabel?: string
    testId?: string
    options: Array<{ value: string; label: string }>
  }
  const collect = (node: React.ReactNode, sink: Harvest): void => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return
      const props = child.props as {
        children?: React.ReactNode
        value?: string
        "aria-label"?: string
        "data-testid"?: string
      }
      const kind = (child.type as React.ComponentType & { displayName?: string }).displayName
      if (kind === "SelectTriggerStub") {
        if (props["aria-label"]) sink.ariaLabel = props["aria-label"]
        if (props["data-testid"]) sink.testId = props["data-testid"]
      }
      if (kind === "SelectItemStub") {
        sink.options.push({
          value: props.value ?? "",
          label: typeof props.children === "string" ? props.children : "",
        })
        return
      }
      collect(props.children, sink)
    })
  }
  const Trigger: React.FC<
    React.HTMLAttributes<HTMLDivElement> & {
      "aria-label"?: string
      "data-testid"?: string
    }
  > = ({ children }) => <>{children}</>
  ;(Trigger as React.FC & { displayName?: string }).displayName = "SelectTriggerStub"
  const Item: React.FC<{ value: string; children: React.ReactNode }> = ({ children }) => (
    <>{children}</>
  )
  ;(Item as React.FC & { displayName?: string }).displayName = "SelectItemStub"
  const Select: React.FC<{
    value: string
    onValueChange: (v: string) => void
    disabled?: boolean
    children: React.ReactNode
  }> = ({ value, onValueChange, disabled, children }) => {
    const harvest: Harvest = { options: [] }
    collect(children, harvest)
    return (
      <select
        aria-label={harvest.ariaLabel}
        data-testid={harvest.testId}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        <option value="">__placeholder__</option>
        {harvest.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: Trigger,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectItem: Item,
  }
})

import { TwinCronCard } from "./twin-cron-card"

beforeEach(() => {
  updateTwinMock.mockClear()
  syncCronMock.mockClear()
})

describe("TwinCronCard", () => {
  it("renders the title and toggle", async () => {
    render(<TwinCronCard twinId="twin_alice" />)
    expect(await screen.findByText(/Auto-ingest & auto-distill/i)).toBeInTheDocument()
    expect(screen.getByTestId("twin-cron-enabled")).toBeInTheDocument()
  })

  it("saves the cron schedule when Save is clicked", async () => {
    render(<TwinCronCard twinId="twin_alice" />)
    await userEvent.click(screen.getByTestId("twin-cron-enabled"))
    const ingestInput = screen.getByTestId("twin-cron-ingest") as HTMLInputElement
    fireEvent.change(ingestInput, { target: { value: "0 */6 * * *" } })
    await userEvent.click(screen.getByTestId("twin-cron-save"))
    await waitFor(() => {
      expect(updateTwinMock).toHaveBeenCalledTimes(1)
      const [twinId, patch] = updateTwinMock.mock.calls[0]
      expect(twinId).toBe("twin_alice")
      expect(patch.cron.enabled).toBe(true)
      expect(patch.cron.ingestSchedule).toBe("0 */6 * * *")
    })
    expect(syncCronMock).toHaveBeenCalled()
  })

  it("picks a preset and pushes it into the ingest input", async () => {
    render(<TwinCronCard twinId="twin_alice" />)
    // Enable so the dropdown is interactive.
    await userEvent.click(screen.getByTestId("twin-cron-enabled"))
    const presetSelect = (await screen.findByTestId("twin-cron-ingest-preset")) as HTMLSelectElement
    const firstReal = Array.from(presetSelect.options).find((o) => o.value !== "")
    expect(firstReal).toBeDefined()
    await userEvent.selectOptions(presetSelect, firstReal!.value)
    const ingestInput = screen.getByTestId("twin-cron-ingest") as HTMLInputElement
    expect(ingestInput.value).toBe(firstReal!.value)
  })
})
