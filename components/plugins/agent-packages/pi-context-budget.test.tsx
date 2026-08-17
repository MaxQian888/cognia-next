/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { computePiContextBudget } from "@/lib/pi-packages/budget"
import type { PiPackageSource } from "@/lib/pi-packages/types"
import messages from "@/i18n/messages/en.json"
import { PiContextBudget, piPackageShortName } from "./pi-context-budget"

// recharts measures its container; jsdom reports 0×0, so the chart is stubbed.
// The numbers it draws come from `computePiContextBudget`, which has its own
// tests — what matters here is that the component reads the right fields.
jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="rc-container">{children}</div>
  ),
  BarChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="rc-chart" data-bars={data.length} />
  ),
  Bar: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}))

function renderBudget(installed: readonly PiPackageSource[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PiContextBudget budget={computePiContextBudget(installed)} />
    </NextIntlClientProvider>
  )
}

describe("piPackageShortName", () => {
  it("drops the prefix and the version pin", () => {
    expect(piPackageShortName("npm:pi-memory@0.4.2")).toBe("pi-memory")
  })

  /**
   * Keeping the scope is load-bearing: `@narumitw/pi-subagents` and
   * `@gotgenes/pi-subagents` are the exact pair the overlap view distinguishes,
   * and stripping the scope would render them identically.
   */
  it("keeps the npm scope", () => {
    expect(piPackageShortName("npm:@narumitw/pi-subagents@1.0.0")).toBe("@narumitw/pi-subagents")
  })

  it("leaves an unpinned scoped name alone", () => {
    expect(piPackageShortName("npm:@a/b")).toBe("@a/b")
  })

  it("handles git and local specs", () => {
    expect(piPackageShortName("git:github.com/o/r")).toBe("github.com/o/r")
    expect(piPackageShortName("local:/tmp/ext")).toBe("/tmp/ext")
  })
})

describe("PiContextBudget", () => {
  it("says nothing is being paid for when nothing is installed", () => {
    renderBudget([])
    expect(screen.getByText(/nothing is being paid for/i)).toBeInTheDocument()
    expect(screen.queryByTestId("pi-budget-chart")).not.toBeInTheDocument()
  })

  it("totals tools and always-on tokens across the installed set", () => {
    renderBudget(["npm:pi-memory@0.4.2", "npm:@narumitw/pi-plan-mode@0.49.3"])
    expect(screen.getByTestId("pi-budget-tools")).toHaveTextContent("10")
    expect(screen.getByTestId("pi-budget-tokens")).toHaveTextContent("2,000")
  })

  /**
   * The distinction the whole model exists for: an unreviewed package is
   * reported as unmeasured, never silently as zero.
   */
  it("reports unreviewed packages as unmeasured rather than free", () => {
    renderBudget(["npm:pi-hermes-memory@1.0.0"])
    const unknown = screen.getByTestId("pi-budget-unknown")
    expect(unknown).toHaveTextContent("1 package unmeasured")
    expect(unknown).toHaveTextContent(/not the same as zero/i)
    expect(screen.getByTestId("pi-budget-tokens")).toHaveTextContent("0")
  })

  /**
   * Spawned contexts get their own dimension because one subagent task can cost
   * more than every schema in the catalog combined.
   */
  it("lists context-spawning packages separately from the token total", () => {
    renderBudget(["npm:@narumitw/pi-subagents@1.0.0"])
    expect(screen.getByText("@narumitw/pi-subagents@1.0.0")).toBeInTheDocument()
    expect(screen.getByText(/dominates cost far more than schema size/i)).toBeInTheDocument()
  })

  it("does not claim spawned contexts when none of the packages can start one", () => {
    renderBudget(["npm:@narumitw/pi-statusline@0.49.6"])
    expect(screen.queryByText(/Can start extra model contexts/i)).not.toBeInTheDocument()
  })

  it("warns when the tool count passes the advisory ceiling", () => {
    // pi-subagents (8) + pi-memory (7) + web-access (4) + chrome-devtools (5)
    // + lsp (2) + plan-mode (3) + goal (3) + workflow (4) + mcp (1) = 37; add
    // the two ask/todo tools and the permission-modes pair to cross 40.
    renderBudget([
      "npm:pi-subagents@0.47.1",
      "npm:pi-memory@0.4.2",
      "npm:pi-web-access@0.22.0",
      "npm:@narumitw/pi-chrome-devtools@0.51.0",
      "npm:@narumitw/pi-lsp@0.49.4",
      "npm:@narumitw/pi-plan-mode@0.49.3",
      "npm:@narumitw/pi-goal@0.51.0",
      "npm:@narumitw/pi-workflow@0.2.0",
      "npm:pi-mcp-adapter@2.23.0",
      "npm:@juicesharp/rpiv-todo@2.4.0",
      "npm:@juicesharp/rpiv-ask-user-question@2.4.0",
      "npm:pi-permission-modes@2.2.0",
    ])
    expect(screen.getAllByText(/Over the advisory ceiling/i).length).toBeGreaterThan(0)
  })

  it("caps the chart at eight bars, keeping the largest", () => {
    renderBudget([
      "npm:pi-subagents@0.47.1",
      "npm:pi-memory@0.4.2",
      "npm:pi-web-access@0.22.0",
      "npm:@narumitw/pi-chrome-devtools@0.51.0",
      "npm:@narumitw/pi-lsp@0.49.4",
      "npm:@narumitw/pi-plan-mode@0.49.3",
      "npm:@narumitw/pi-goal@0.51.0",
      "npm:@narumitw/pi-workflow@0.2.0",
      "npm:pi-mcp-adapter@2.23.0",
      "npm:@vtstech/pi-long-term-memory@1.3.5",
    ])
    expect(screen.getByTestId("rc-chart")).toHaveAttribute("data-bars", "8")
  })

  it("omits the chart when every installed package is zero-cost", () => {
    renderBudget(["npm:@narumitw/pi-statusline@0.49.6", "npm:@narumitw/pi-worktree@0.50.0"])
    expect(screen.queryByTestId("pi-budget-chart")).not.toBeInTheDocument()
    expect(screen.getByTestId("pi-budget-tokens")).toHaveTextContent("0")
  })
})
