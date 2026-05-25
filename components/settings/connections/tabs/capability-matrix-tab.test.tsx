/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { A2UI_COMPONENT_KINDS } from "@/types/connectors/capability"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))

// The component renders a <Tooltip> per cell; the real Radix Tooltip throws
// without a TooltipProvider ancestor (mounted in layout, absent in tests), so
// substitute the shared manual mock.
jest.mock("@/components/ui/tooltip")

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { CapabilityMatrixTab } from "./capability-matrix-tab"

// One adapter with a probed matrix (mixed tiers), one without (→ all fallback).
const adapters: Partial<AdapterInstanceRow>[] = [
  {
    id: "a1",
    displayName: "Telegram Bot",
    type: "telegram",
    lastKnownCapabilities: {
      Button: "native",
      TextField: "simulated",
      Slider: "unsupported",
      // Select intentionally omitted → resolveCell defaults it to "fallback".
    } as AdapterInstanceRow["lastKnownCapabilities"],
  },
  {
    id: "a2",
    displayName: "Discord Bot",
    type: "discord",
    // No lastKnownCapabilities → every cell reads "fallback".
  },
]

beforeEach(() => {
  jest.clearAllMocks()
})

describe("CapabilityMatrixTab", () => {
  it("shows the empty state when no adapters are configured", () => {
    mockUseLiveQuery.mockReturnValue([] as unknown as AdapterInstanceRow[])
    render(<CapabilityMatrixTab />)
    const empty = screen.getByTestId("capability-matrix-empty")
    expect(empty).toBeInTheDocument()
    expect(empty).toHaveTextContent(/no adapters configured/i)
    expect(screen.queryByTestId("capability-matrix-tab")).not.toBeInTheDocument()
  })

  it("renders one column per adapter with name + type", () => {
    mockUseLiveQuery.mockReturnValue(adapters as unknown as AdapterInstanceRow[])
    render(<CapabilityMatrixTab />)
    expect(screen.getByTestId("capability-matrix-tab")).toBeInTheDocument()

    const colA = screen.getByTestId("capability-col-a1")
    expect(colA).toHaveTextContent("Telegram Bot")
    expect(colA).toHaveTextContent("telegram")
    const colB = screen.getByTestId("capability-col-a2")
    expect(colB).toHaveTextContent("Discord Bot")
    expect(colB).toHaveTextContent("discord")
  })

  it("renders one row per A2UI component kind", () => {
    mockUseLiveQuery.mockReturnValue(adapters as unknown as AdapterInstanceRow[])
    const { container } = render(<CapabilityMatrixTab />)
    const rows = container.querySelectorAll('[data-testid^="capability-row-"]')
    expect(rows).toHaveLength(A2UI_COMPONENT_KINDS.length)
  })

  it("resolves each cell's tier from lastKnownCapabilities (missing → fallback)", () => {
    mockUseLiveQuery.mockReturnValue(adapters as unknown as AdapterInstanceRow[])
    render(<CapabilityMatrixTab />)

    // Probed adapter: explicit tiers survive; an unlisted kind degrades.
    expect(screen.getByTestId("capability-cell-a1-Button")).toHaveAttribute("data-tier", "native")
    expect(screen.getByTestId("capability-cell-a1-TextField")).toHaveAttribute(
      "data-tier",
      "simulated"
    )
    expect(screen.getByTestId("capability-cell-a1-Slider")).toHaveAttribute(
      "data-tier",
      "unsupported"
    )
    expect(screen.getByTestId("capability-cell-a1-Select")).toHaveAttribute("data-tier", "fallback")

    // Unprobed adapter: every cell falls back.
    expect(screen.getByTestId("capability-cell-a2-Button")).toHaveAttribute("data-tier", "fallback")
    expect(screen.getByTestId("capability-cell-a2-Slider")).toHaveAttribute("data-tier", "fallback")
  })

  it("renders the four-tier legend", () => {
    mockUseLiveQuery.mockReturnValue(adapters as unknown as AdapterInstanceRow[])
    render(<CapabilityMatrixTab />)
    // Each tier label renders at least once (legend + any matching cells).
    for (const label of ["Native", "Simulated", "Fallback", "Unsupported"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1)
    }
  })
})
