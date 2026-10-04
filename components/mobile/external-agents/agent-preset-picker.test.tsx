/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import { AgentPresetPicker } from "./agent-preset-picker"
import type { InstalledRuntime } from "@/lib/ai/agent/external/config/installed-runtimes"

const installedIds: { current: Set<string> } = { current: new Set() }

function installed(runtimeId: string): InstalledRuntime {
  return {
    runtimeId,
    command: runtimeId,
    resolution: "installed",
    executablePath: `/usr/local/bin/${runtimeId}`,
    version: "1.0.0",
    detail: null,
  }
}

jest.mock("@/hooks/agent/use-installed-agent-runtimes", () => ({
  useInstalledAgentRuntimes: () => ({
    loading: false,
    unavailable: null,
    runtimes: [],
    forPreset: (presetId: string) =>
      installedIds.current.has(presetId) ? installed(presetId) : undefined,
    refresh: jest.fn(),
  }),
}))

// The app mounts `TooltipProvider` in `app/layout.tsx`; the detection badge needs it.
function renderPicker() {
  return render(
    <TooltipProvider>
      <AgentPresetPicker />
    </TooltipProvider>
  )
}

beforeEach(() => {
  installedIds.current = new Set(["claude-code", "gemini-cli"])
})

describe("AgentPresetPicker", () => {
  it("puts presets the Host has installed in their own group, ahead of the rest", () => {
    renderPicker()
    const installedGroup = screen.getByTestId("agent-preset-group-installed")
    const allGroup = screen.getByTestId("agent-preset-group-all")

    expect(within(installedGroup).getByTestId("agent-preset-claude-code")).toBeInTheDocument()
    expect(within(installedGroup).getByTestId("agent-preset-gemini-cli")).toBeInTheDocument()
    expect(within(installedGroup).queryByTestId("agent-preset-kiro")).toBeNull()

    expect(within(allGroup).getByTestId("agent-preset-kiro")).toBeInTheDocument()
    expect(within(allGroup).queryByTestId("agent-preset-claude-code")).toBeNull()
  })

  it("omits the installed group when the Host reports nothing installed", () => {
    installedIds.current = new Set()
    renderPicker()
    expect(screen.queryByTestId("agent-preset-group-installed")).toBeNull()
    expect(
      within(screen.getByTestId("agent-preset-group-all")).getByTestId("agent-preset-claude-code")
    ).toBeInTheDocument()
  })

  it("links every card to the review step for its preset", () => {
    renderPicker()
    expect(screen.getByTestId("agent-preset-claude-code")).toHaveAttribute(
      "href",
      "/me/external-agents/new/configure?preset=claude-code"
    )
    expect(screen.getByTestId("agent-preset-kiro")).toHaveAttribute(
      "href",
      "/me/external-agents/new/configure?preset=kiro"
    )
    expect(screen.getByTestId("agent-preset-custom")).toHaveAttribute(
      "href",
      "/me/external-agents/new/configure?preset=custom"
    )
  })

  it("filters both groups by name and keeps the custom card reachable", () => {
    renderPicker()
    fireEvent.change(screen.getByTestId("agent-preset-search"), { target: { value: "Kiro" } })

    expect(screen.getByTestId("agent-preset-kiro")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-preset-claude-code")).toBeNull()
    expect(screen.queryByTestId("agent-preset-group-installed")).toBeNull()
    expect(screen.getByTestId("agent-preset-custom")).toBeInTheDocument()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("keeps the installed signal during a search", () => {
    renderPicker()
    fireEvent.change(screen.getByTestId("agent-preset-search"), {
      target: { value: "Claude Code" },
    })
    expect(
      within(screen.getByTestId("agent-preset-group-installed")).getByTestId(
        "agent-preset-claude-code"
      )
    ).toBeInTheDocument()
  })

  it("says nothing matches, and still offers custom, for a query with no hits", () => {
    renderPicker()
    fireEvent.change(screen.getByTestId("agent-preset-search"), {
      target: { value: "  zzz-no-such-agent  " },
    })

    expect(screen.getByRole("status")).toHaveTextContent("No agent matches “zzz-no-such-agent”.")
    expect(screen.queryByTestId("agent-preset-group-installed")).toBeNull()
    expect(screen.getByTestId("agent-preset-custom")).toBeInTheDocument()
  })
})
