/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SlaEscalationDefaults, parseSlaMinutes } from "./sla-escalation-defaults"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && "error" in vars ? `${key}:${String(vars.error)}` : key,
}))
let mockAdapterRow: Record<string, unknown> = {
  id: "a",
  type: "telegram",
  updatedAt: 1,
  defaultSlaResponseMinutes: 30,
  defaultEscalation: { steps: [{ afterOverdueMinutes: 0, actions: [{ type: "notify" }] }] },
}
const mockCharacters = [{ id: "c1", name: "Ava" }]
jest.mock("dexie-react-hooks", () => ({
  // The card issues two live queries: the adapter row (deps=[adapterId]) and
  // the character list (deps=[]).
  useLiveQuery: (_q: unknown, deps: unknown[]) =>
    deps.length === 1 ? mockAdapterRow : mockCharacters,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
const mockUpdateAdapterConfigSection = jest.fn()
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterConfigSection: (...args: unknown[]) => mockUpdateAdapterConfigSection(...args),
}))
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: { teams: Record<string, never> }) => unknown) =>
    selector({ teams: {} }),
}))

beforeEach(() => {
  mockUpdateAdapterConfigSection.mockReset().mockResolvedValue(undefined)
  mockAdapterRow = {
    id: "a",
    type: "telegram",
    updatedAt: 1,
    defaultSlaResponseMinutes: 30,
    defaultEscalation: { steps: [{ afterOverdueMinutes: 0, actions: [{ type: "notify" }] }] },
  }
})

describe("parseSlaMinutes", () => {
  it("parses positive integers and rejects the rest", () => {
    expect(parseSlaMinutes("")).toBeUndefined()
    expect(parseSlaMinutes(" 15 ")).toBe(15)
    expect(parseSlaMinutes("2.6")).toBe(3)
    expect(parseSlaMinutes("0")).toBeUndefined()
    expect(parseSlaMinutes("-3")).toBeUndefined()
    expect(parseSlaMinutes("abc")).toBeUndefined()
  })
})

describe("SlaEscalationDefaults", () => {
  it("seeds the draft from the adapter row and renders the shared editor in adapter scope", () => {
    render(<SlaEscalationDefaults adapterId="a" />)
    expect(screen.getByTestId("sla-escalation-defaults")).toBeInTheDocument()
    expect(screen.getByTestId("adapter-sla-minutes")).toHaveValue(30)
    expect(screen.getByTestId("adapter-escalation-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("adapter-escalation-override")).not.toBeInTheDocument()
    expect(screen.getByTestId("adapter-escalation-step-0-notify")).toHaveAttribute(
      "data-state",
      "checked"
    )
    // Telegram bot → the Lark-only urgent action is inert (disabled + hint).
    expect(screen.getByTestId("adapter-escalation-step-0-urgent")).toBeDisabled()
    expect(screen.getByTestId("adapter-escalation-step-0-urgent-lark-only")).toBeInTheDocument()
  })

  it("persists SLA minutes + escalation through the delivery config section with its audit source", async () => {
    const user = userEvent.setup()
    render(<SlaEscalationDefaults adapterId="a" />)
    fireEvent.change(screen.getByTestId("adapter-sla-minutes"), { target: { value: "45" } })
    await user.click(screen.getByTestId("adapter-escalation-add-step"))
    await user.click(screen.getByTestId("sla-escalation-save"))
    await waitFor(() =>
      expect(mockUpdateAdapterConfigSection).toHaveBeenCalledWith(
        "a",
        "delivery",
        {
          defaultSlaResponseMinutes: 45,
          defaultEscalation: {
            steps: [
              { afterOverdueMinutes: 0, actions: [{ type: "notify" }] },
              { afterOverdueMinutes: 15, actions: [{ type: "notify" }] },
            ],
          },
        },
        "settings.adapter.sla-escalation"
      )
    )
  })

  it("normalises an empty chain and empty minutes to undefined (no default)", async () => {
    const user = userEvent.setup()
    render(<SlaEscalationDefaults adapterId="a" />)
    fireEvent.change(screen.getByTestId("adapter-sla-minutes"), { target: { value: "" } })
    await user.click(screen.getByTestId("adapter-escalation-step-0-remove"))
    await user.click(screen.getByTestId("sla-escalation-save"))
    await waitFor(() =>
      expect(mockUpdateAdapterConfigSection).toHaveBeenCalledWith(
        "a",
        "delivery",
        { defaultSlaResponseMinutes: undefined, defaultEscalation: undefined },
        "settings.adapter.sla-escalation"
      )
    )
  })

  it("blocks Save while the chain is invalid and re-enables it once fixed", async () => {
    const user = userEvent.setup()
    render(<SlaEscalationDefaults adapterId="a" />)
    await user.click(screen.getByTestId("adapter-escalation-step-0-notify")) // step 0 now has no action
    expect(screen.getByTestId("adapter-escalation-issues")).toBeInTheDocument()
    expect(screen.getByTestId("sla-escalation-save")).toBeDisabled()
    await user.click(screen.getByTestId("adapter-escalation-step-0-notify"))
    expect(screen.getByTestId("sla-escalation-save")).toBeEnabled()
    expect(mockUpdateAdapterConfigSection).not.toHaveBeenCalled()
  })

  it("Cancel resets the draft to the persisted row", async () => {
    const user = userEvent.setup()
    render(<SlaEscalationDefaults adapterId="a" />)
    fireEvent.change(screen.getByTestId("adapter-sla-minutes"), { target: { value: "5" } })
    expect(screen.getByTestId("adapter-sla-minutes")).toHaveValue(5)
    await user.click(screen.getByRole("button", { name: "cancel" }))
    expect(screen.getByTestId("adapter-sla-minutes")).toHaveValue(30)
  })

  it("surfaces a save failure inline", async () => {
    mockUpdateAdapterConfigSection.mockRejectedValueOnce(new Error("Adapter instance not found: a"))
    const user = userEvent.setup()
    render(<SlaEscalationDefaults adapterId="a" />)
    await user.click(screen.getByTestId("sla-escalation-save"))
    expect(await screen.findByTestId("sla-escalation-error")).toHaveTextContent(
      "saveFailed:Adapter instance not found: a"
    )
  })

  it("enables the urgent action on a Lark bot", () => {
    mockAdapterRow = { ...mockAdapterRow, type: "lark" }
    render(<SlaEscalationDefaults adapterId="a" />)
    expect(screen.getByTestId("adapter-escalation-step-0-urgent")).toBeEnabled()
    expect(
      screen.queryByTestId("adapter-escalation-step-0-urgent-lark-only")
    ).not.toBeInTheDocument()
  })

  it("renders an empty draft while the row is still loading", () => {
    mockAdapterRow = undefined as never
    render(<SlaEscalationDefaults adapterId="a" />)
    expect(screen.getByTestId("adapter-sla-minutes")).toHaveValue(null)
    expect(screen.getByTestId("adapter-escalation-empty")).toBeInTheDocument()
  })
})
