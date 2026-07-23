/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { AgentLivenessChip, livenessState } from "./agent-liveness-chip"
import type { AgentLiveness } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/hooks/fleet/use-now-ticker", () => ({
  useNowTicker: () => 60_000,
}))

function liveness(overrides: Partial<AgentLiveness> = {}): AgentLiveness {
  return {
    agent: "codex",
    lastSeenAt: null,
    lastAcceptedAt: null,
    seenCount: 0,
    acceptedCount: 0,
    ...overrides,
  }
}

describe("livenessState", () => {
  it("reads a missing row as silent", () => {
    // No row at all is the same fact as a row that has never seen anything:
    // the agent's hooks have not fired.
    expect(livenessState(undefined)).toBe("silent")
    expect(livenessState(liveness())).toBe("silent")
  })

  it("distinguishes events arriving-but-dropped from silence", () => {
    // This is the whole point of the two clocks: an integration that is firing
    // and having every event thrown away is broken in a completely different
    // way from one that was never trusted, and the fix differs too.
    expect(livenessState(liveness({ lastSeenAt: 1, seenCount: 4 }))).toBe("dropping")
  })

  it("reads an accepted event as live", () => {
    expect(livenessState(liveness({ lastSeenAt: 1, lastAcceptedAt: 1, acceptedCount: 1 }))).toBe(
      "live"
    )
  })
})

describe("AgentLivenessChip", () => {
  it("renders nothing when the integration isn't installed", () => {
    // An uninstalled integration is legitimately silent; saying so would be
    // noise next to a switch that is plainly off.
    const { container } = render(
      <AgentLivenessChip agent="codex" liveness={undefined} installed={false} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("warns amber while an installed integration has produced nothing", () => {
    // The Codex case: hooks written to disk, trust never granted in its TUI,
    // and no way to read that trust — observed silence is the only honest signal.
    render(<AgentLivenessChip agent="codex" liveness={undefined} installed />)
    const chip = screen.getByTestId("fleet-liveness-codex")
    expect(chip.getAttribute("data-state")).toBe("silent")
    expect(chip).toHaveTextContent("silent")
  })

  it("flags an integration whose events are all being dropped", () => {
    render(
      <AgentLivenessChip
        agent="codex"
        liveness={liveness({ lastSeenAt: 10, seenCount: 7 })}
        installed
      />
    )
    const chip = screen.getByTestId("fleet-liveness-codex")
    expect(chip.getAttribute("data-state")).toBe("dropping")
    expect(chip).toHaveTextContent("dropping")
  })

  it("shows how long ago the last accepted event was", () => {
    render(
      <AgentLivenessChip
        agent="claude-code"
        liveness={liveness({
          agent: "claude-code",
          lastSeenAt: 0,
          lastAcceptedAt: 0,
          acceptedCount: 3,
        })}
        installed
      />
    )
    const chip = screen.getByTestId("fleet-liveness-claude-code")
    expect(chip.getAttribute("data-state")).toBe("live")
    // Ticker is pinned at 60s; formatElapsed renders that as "1m00s".
    expect(chip).toHaveTextContent('live:{"ago":"1m00s"}')
  })
})
