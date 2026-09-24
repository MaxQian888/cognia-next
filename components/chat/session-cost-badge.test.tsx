// Coverage for the per-session cost badge popover.

import { fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import userEvent from "@testing-library/user-event"
import { SessionCostBadge } from "./session-cost-badge"

let liveQueryReturn: unknown[] | undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveQueryReturn,
}))

jest.mock("@/lib/db/session-usage", () => ({
  listUsageForSession: jest.fn(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const tokens = (input: string, output: string) => `Tokens ${input}/${output}`

beforeEach(() => {
  liveQueryReturn = undefined
})

// Radix tooltips throw without a provider — app/layout mounts one in production.
const renderUI = (ui: Parameters<typeof render>[0]) =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

describe("SessionCostBadge — collapsed", () => {
  it("renders in-memory totals + cost when known", () => {
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{
          inputTokens: 1500,
          outputTokens: 700,
          totalCostUsd: 0.12,
        }}
        tokensLabel={tokens}
      />
    )
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("Tokens 1.5k/700")
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("$0.1200")
  })

  it("hides the cost suffix when totalCostUsd is 0", () => {
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ inputTokens: 0, outputTokens: 0, totalCostUsd: 0 }}
        tokensLabel={tokens}
      />
    )
    expect(screen.getByTestId("session-cost-trigger")).not.toHaveTextContent("$")
  })

  it("falls back to 0 when usage fields are undefined", () => {
    renderUI(<SessionCostBadge sessionId="s1" inMemoryUsage={{}} tokensLabel={tokens} />)
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("Tokens 0/0")
  })

  // The badge used to hide below the `sm` viewport breakpoint — useless on a
  // narrow sidebar inside a wide window. Visibility is now the toolbar fold
  // tier's call; the badge itself just renders.
  it("renders at every viewport — width is the container's business, not a media query's", () => {
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ inputTokens: 5, outputTokens: 2, totalCostUsd: 0.01 }}
        tokensLabel={tokens}
      />
    )
    const trigger = screen.getByTestId("session-cost-trigger")
    expect(trigger.className).toContain("inline-flex")
    expect(trigger.className).not.toContain("hidden")
  })

  it("renders the compact `$x.xx` form when the toolbar fold tier is short on room", () => {
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ inputTokens: 1500, outputTokens: 700, totalCostUsd: 0.1234 }}
        tokensLabel={tokens}
        compact
      />
    )
    const trigger = screen.getByTestId("session-cost-trigger")
    expect(trigger).toHaveAttribute("data-compact", "true")
    expect(trigger).toHaveTextContent("$0.12")
    expect(trigger).not.toHaveTextContent("Tokens")
  })

  it("falls back to the compact token pair in the short form before the first billed turn", () => {
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ inputTokens: 1500, outputTokens: 700, totalCostUsd: 0 }}
        tokensLabel={tokens}
        compact
      />
    )
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("Tokens 1.5k/700")
  })
})

describe("SessionCostBadge — popover with persisted rows", () => {
  it("renders the empty state when no rows are persisted", async () => {
    liveQueryReturn = []
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ totalCostUsd: 0.01 }}
        tokensLabel={tokens}
      />
    )
    await user.click(screen.getByTestId("session-cost-trigger"))
    expect(await screen.findByTestId("cost-popover-empty")).toBeInTheDocument()
  })

  it("keeps reported totals for older external turns without fabricating ledger details", async () => {
    liveQueryReturn = []
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="pi-session"
        inMemoryUsage={{ inputTokens: 267000, outputTokens: 11, totalCostUsd: 0.25 }}
        tokensLabel={tokens}
      />
    )
    await user.click(screen.getByTestId("session-cost-trigger"))
    expect(await screen.findByTestId("cost-popover-turns")).toHaveTextContent("—")
    expect(screen.getByText("267k")).toBeInTheDocument()
    expect(screen.getByText("11")).toBeInTheDocument()
    expect(screen.getByText("$0.2500")).toBeInTheDocument()
    expect(screen.getByTestId("cost-popover-empty")).toBeInTheDocument()
  })

  it("keeps historical totals when only the newest Pi turn has a ledger row", async () => {
    liveQueryReturn = [
      {
        messageId: "new",
        sessionId: "pi-session",
        at: 1,
        model: "pi-model",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 1,
        costUsd: 0.1,
        durationMs: 1000,
      },
    ]
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="pi-session"
        tokensLabel={tokens}
        inMemoryUsage={{
          inputTokens: 267010,
          outputTokens: 13,
          cacheReadInputTokens: 43,
          cacheCreationInputTokens: 7,
          totalCostUsd: 0.35,
        }}
      />
    )
    await user.click(screen.getByTestId("session-cost-trigger"))
    expect(await screen.findByTestId("cost-popover-turns")).toHaveTextContent("—")
    expect(screen.getByText("267k")).toBeInTheDocument()
    expect(screen.getByText("13")).toBeInTheDocument()
    expect(screen.getByText("$0.3500")).toBeInTheDocument()
    expect(screen.getByTestId("cost-popover-speed")).toHaveTextContent("—")
    expect(screen.getByText("partialModelData")).toBeInTheDocument()
    expect(screen.getByTestId("cost-popover-by-model")).toHaveTextContent("pi-model")
  })

  it("uses complete ledger totals for the chip when only recent messages are loaded", async () => {
    liveQueryReturn = [
      {
        messageId: "m",
        sessionId: "s1",
        at: 1,
        inputTokens: 2000,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.5,
        durationMs: 1000,
      },
    ]
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        tokensLabel={tokens}
        inMemoryUsage={{ inputTokens: 10, outputTokens: 2, totalCostUsd: 0.1 }}
      />
    )
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("2.0k")
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("0.5000")
    await user.click(screen.getByTestId("session-cost-trigger"))
    expect(await screen.findByTestId("cost-popover-turns")).toHaveTextContent("1")
    expect(screen.queryByText("partialModelData")).toBeNull()
  })

  it("retains known ledger input and cost while newer message output is still unpersisted", async () => {
    liveQueryReturn = [
      {
        messageId: "m",
        sessionId: "s1",
        at: 1,
        inputTokens: 2000,
        outputTokens: 50,
        cacheReadTokens: 100,
        cacheCreationTokens: 5,
        costUsd: 0.5,
        durationMs: 1000,
      },
    ]
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        tokensLabel={tokens}
        inMemoryUsage={{ inputTokens: 10, outputTokens: 60 }}
      />
    )
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("2.0k")
    expect(screen.getByTestId("session-cost-trigger")).toHaveTextContent("0.5000")
    await user.click(screen.getByTestId("session-cost-trigger"))
    expect(screen.getByText("60")).toBeInTheDocument()
    expect(screen.getByText("$0.5000")).toBeInTheDocument()
    expect(screen.getByText("partialModelData")).toBeInTheDocument()
    expect(screen.getByTestId("cost-popover-turns")).toHaveTextContent("—")
  })

  it("keeps newly reported reasoning even when other ledger counters already match", async () => {
    liveQueryReturn = [
      {
        messageId: "m",
        sessionId: "s1",
        at: 1,
        inputTokens: 10,
        outputTokens: 60,
        reasoningTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.5,
        durationMs: 1000,
      },
    ]
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        tokensLabel={tokens}
        inMemoryUsage={{ inputTokens: 10, outputTokens: 60, reasoningTokens: 7, totalCostUsd: 0.5 }}
      />
    )
    await user.click(screen.getByTestId("session-cost-trigger"))
    expect(screen.getByText("7")).toBeInTheDocument()
    expect(screen.getByText("partialModelData")).toBeInTheDocument()
  })

  it("aggregates rows + builds per-model breakdown sorted by cost desc", async () => {
    liveQueryReturn = [
      {
        messageId: "m1",
        sessionId: "s1",
        at: 0,
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 10,
        costUsd: 0.05,
        durationMs: 0,
      },
      {
        messageId: "m2",
        sessionId: "s1",
        at: 0,
        model: "claude-opus-4-7",
        inputTokens: 200,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.5,
        durationMs: 0,
      },
      {
        messageId: "m3",
        sessionId: "s1",
        at: 0,
        model: "claude-sonnet-4-5",
        inputTokens: 50,
        outputTokens: 25,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.02,
        durationMs: 0,
      },
    ]
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ inputTokens: 350, outputTokens: 175, totalCostUsd: 0.57 }}
        tokensLabel={tokens}
      />
    )
    await user.click(screen.getByTestId("session-cost-trigger"))
    const turns = await screen.findByTestId("cost-popover-turns")
    expect(turns).toHaveTextContent("3")
    const list = screen.getByTestId("cost-popover-by-model")
    const items = list.querySelectorAll("li")
    expect(items).toHaveLength(2)
    // Highest cost first
    expect(items[0]).toHaveTextContent("claude-opus-4-7")
    expect(items[1]).toHaveTextContent("claude-sonnet-4-5")
  })

  it("shows throughput, gen time and cache-hit rate when durations are reported", async () => {
    liveQueryReturn = [
      {
        messageId: "m1",
        sessionId: "s1",
        at: 0,
        model: "claude-x",
        inputTokens: 100,
        outputTokens: 500,
        cacheCreationTokens: 200,
        cacheReadTokens: 800,
        costUsd: 0.05,
        durationMs: 10_000,
        reasoningTokens: 40,
      },
    ]
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ totalCostUsd: 0.05 }}
        tokensLabel={tokens}
      />
    )
    await user.click(screen.getByTestId("session-cost-trigger"))
    // speed available (500 out / 10s) → renders the tokPerSec row, not "—".
    const speed = await screen.findByTestId("cost-popover-speed")
    expect(speed).not.toHaveTextContent("—")
    // cache hit = 800 / (800 + 200) = 80%.
    expect(screen.getByTestId("cost-popover-cache-hit")).toHaveTextContent("80%")
  })

  it("buckets rows with no model under '(unknown)'", async () => {
    liveQueryReturn = [
      {
        messageId: "m1",
        sessionId: "s1",
        at: 0,
        model: "",
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.01,
        durationMs: 0,
      },
    ]
    const user = userEvent.setup()
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ totalCostUsd: 0.01 }}
        tokensLabel={tokens}
      />
    )
    await user.click(screen.getByTestId("session-cost-trigger"))
    const list = await screen.findByTestId("cost-popover-by-model")
    expect(list).toHaveTextContent("(unknown)")
  })

  it("falls back to empty breakdown when useLiveQuery is still pending", () => {
    liveQueryReturn = undefined
    renderUI(
      <SessionCostBadge
        sessionId="s1"
        inMemoryUsage={{ totalCostUsd: 0.01 }}
        tokensLabel={tokens}
      />
    )
    // Trigger renders; popover not yet open — no by-model list either.
    expect(screen.queryByTestId("cost-popover-by-model")).toBeNull()
  })

  it("formats large token counts (k / M)", async () => {
    liveQueryReturn = [
      {
        messageId: "m1",
        sessionId: "s1",
        at: 0,
        model: "x",
        inputTokens: 2_500_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        durationMs: 0,
      },
    ]
    const user = userEvent.setup()
    renderUI(<SessionCostBadge sessionId="s1" inMemoryUsage={{}} tokensLabel={tokens} />)
    fireEvent.click(screen.getByTestId("session-cost-trigger"))
    void user
    const list = await screen.findByTestId("cost-popover-by-model")
    expect(list).toHaveTextContent("2.50M")
  })
})
