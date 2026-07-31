/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const mockUpdate = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    adapterInstances: { get: jest.fn(), where: jest.fn() },
  })),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  __esModule: true,
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))

// TWO useLiveQuery reads (adapter row, same-platform siblings) — dispatch on
// the querier source; only the siblings querier uses `where("type")`.
let fixtureRow: AdapterInstanceRow | undefined
let fixtureSiblings: AdapterInstanceRow[]
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    const src = String(fn)
    if (src.includes('where("type")')) return fixtureSiblings
    return fixtureRow
  },
}))

// Native-checkbox stub for the Radix Switch (same pattern as
// dispatch-rules.test.tsx) so fireEvent.click flips it in jsdom.
jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={checked ?? false}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      {...rest}
    />
  ),
}))

import { OutboundTuning } from "./outbound-tuning"
import { DEFAULT_OUTBOUND_TUNING } from "@/lib/connectors/outbound-runner"

function makeRow(patch: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "a1",
    type: "telegram",
    displayName: "Bot A",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as AdapterInstanceRow
}

function setup(rowPatch: Partial<AdapterInstanceRow> = {}, siblings?: AdapterInstanceRow[]): void {
  fixtureRow = makeRow(rowPatch)
  fixtureSiblings = siblings ?? [
    fixtureRow, // self — must be filtered out
    { id: "a2", type: "telegram", displayName: "Bot B", enabled: true } as AdapterInstanceRow,
    { id: "a3", type: "telegram", displayName: "Bot C", enabled: false } as AdapterInstanceRow,
  ]
  mockUpdate.mockClear()
  render(<OutboundTuning adapterId="a1" />)
}

describe("OutboundTuning — tuning knobs", () => {
  it("renders every knob with the runner default as placeholder", () => {
    setup()
    const capacity = screen.getByTestId("outbound-tuning-rateCapacity") as HTMLInputElement
    expect(capacity.placeholder).toBe(String(DEFAULT_OUTBOUND_TUNING.rateCapacity))
    const cooldown = screen.getByTestId("outbound-tuning-breakerCooldownMs") as HTMLInputElement
    expect(cooldown.placeholder).toBe(String(DEFAULT_OUTBOUND_TUNING.breakerCooldownMs))
    // Blank values by default — the row has no tuning.
    expect(capacity.value).toBe("")
  })

  it("persists a typed knob into outboundTuning", () => {
    setup()
    fireEvent.change(screen.getByTestId("outbound-tuning-rateCapacity"), {
      target: { value: "3" },
    })
    expect(mockUpdate).toHaveBeenCalledWith("a1", { outboundTuning: { rateCapacity: 3 } })
  })

  it("merges a new knob with existing knobs", () => {
    setup({ outboundTuning: { rateCapacity: 3 } })
    fireEvent.change(screen.getByTestId("outbound-tuning-breakerMinEvents"), {
      target: { value: "1" },
    })
    expect(mockUpdate).toHaveBeenCalledWith("a1", {
      outboundTuning: { rateCapacity: 3, breakerMinEvents: 1 },
    })
  })

  it("clears the whole block when the last knob empties", () => {
    setup({ outboundTuning: { rateCapacity: 3 } })
    fireEvent.change(screen.getByTestId("outbound-tuning-rateCapacity"), {
      target: { value: "" },
    })
    expect(mockUpdate).toHaveBeenCalledWith("a1", { outboundTuning: undefined })
  })
})

describe("OutboundTuning — failover targets", () => {
  it("lists only enabled non-self same-platform siblings", () => {
    setup()
    expect(screen.getByTestId("outbound-tuning-failover-a2")).toBeInTheDocument()
    expect(screen.queryByTestId("outbound-tuning-failover-a1")).toBeNull()
    expect(screen.queryByTestId("outbound-tuning-failover-a3")).toBeNull()
  })

  it("toggling a sibling on appends it", () => {
    setup()
    fireEvent.click(screen.getByTestId("outbound-tuning-failover-a2"))
    expect(mockUpdate).toHaveBeenCalledWith("a1", { failoverAdapterIds: ["a2"] })
  })

  it("toggling the last sibling off clears the list", () => {
    setup({ failoverAdapterIds: ["a2"] })
    fireEvent.click(screen.getByTestId("outbound-tuning-failover-a2"))
    expect(mockUpdate).toHaveBeenCalledWith("a1", { failoverAdapterIds: undefined })
  })

  it("shows the empty state when the platform has no other enabled bot", () => {
    setup({}, [makeRow()])
    expect(screen.getByTestId("outbound-tuning-no-siblings")).toBeInTheDocument()
  })
})

describe("OutboundTuning — load-balancing targets", () => {
  it("lists the same eligible siblings for balancing", () => {
    setup()
    expect(screen.getByTestId("outbound-tuning-balance-a2")).toBeInTheDocument()
    expect(screen.queryByTestId("outbound-tuning-balance-a1")).toBeNull()
    expect(screen.queryByTestId("outbound-tuning-balance-a3")).toBeNull()
  })

  it("toggling a balance sibling on appends it (independent of failover)", () => {
    setup({ failoverAdapterIds: ["a2"] })
    fireEvent.click(screen.getByTestId("outbound-tuning-balance-a2"))
    expect(mockUpdate).toHaveBeenCalledWith("a1", { balanceAdapterIds: ["a2"] })
  })

  it("toggling the last balance sibling off clears the list", () => {
    setup({ balanceAdapterIds: ["a2"] })
    fireEvent.click(screen.getByTestId("outbound-tuning-balance-a2"))
    expect(mockUpdate).toHaveBeenCalledWith("a1", { balanceAdapterIds: undefined })
  })
})
