/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { CompositionChip } from "./composition-chip"
import compositionMessages from "@/i18n/messages/en/agentComposition.json"
import agentModeMessages from "@/i18n/messages/en/agentMode.json"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"

// The host probe reaches for a Tauri command; the chip only needs the answer.
jest.mock("@/hooks/agent/use-code-sandbox-presentations", () => ({
  useCodeSandboxPresentations: () => ["native"],
}))

// The executor reads Dexie; the chip only needs its answer. Mutable so a test
// can put the conversation on a Squad without a database.
const executorState = {
  squadId: null as string | null,
  squadName: null as string | null,
  squads: [] as Array<{ id: string; name: string }>,
  select: jest.fn(async () => undefined),
  bindable: true,
}
jest.mock("./use-chat-executor", () => ({
  useChatExecutor: () => executorState,
}))

const useIsMobileMock = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => useIsMobileMock() }))

const messages = {
  agentComposition: compositionMessages,
  agentMode: agentModeMessages,
}

function renderChip(props: React.ComponentProps<typeof CompositionChip> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CompositionChip {...props} />
    </NextIntlClientProvider>
  )
}

describe("CompositionChip", () => {
  beforeEach(() => {
    act(() => {
      useAgentRuntimeStore.setState({
        defaultComposition: { presetId: "standard" },
        sessionCompositions: {},
        modeId: "standard",
      })
      useCustomModeStore.setState({ customModes: {} })
    })
    useIsMobileMock.mockReset().mockReturnValue(false)
  })

  afterEach(() => {
    act(() => {
      useAgentRuntimeStore.setState({
        defaultComposition: { presetId: "standard" },
        sessionCompositions: {},
      })
      useCustomModeStore.setState({ customModes: {} })
    })
  })

  it("names the preset the next turn will run as", () => {
    renderChip({ sessionId: "s1" })

    expect(screen.getByTestId("composition-chip")).toHaveTextContent("Standard")
  })

  // The defect the chip replaces: the composer showed the app default while the
  // session had its own selection.
  it("shows this session's selection, not the app default", () => {
    act(() => {
      useAgentRuntimeStore.setState({
        defaultComposition: { presetId: "standard" },
        sessionCompositions: { s1: { presetId: "minimal" } },
      })
    })

    renderChip({ sessionId: "s1" })
    expect(screen.getByTestId("composition-chip")).toHaveTextContent("Minimal")
  })

  it("falls back to the app default for a session that never chose one", () => {
    act(() => {
      useAgentRuntimeStore.setState({
        defaultComposition: { presetId: "minimal" },
        sessionCompositions: { other: { presetId: "standard" } },
      })
    })

    renderChip({ sessionId: "s1" })
    expect(screen.getByTestId("composition-chip")).toHaveTextContent("Minimal")
  })

  it("writes a change to the session, leaving other sessions and the default alone", async () => {
    renderChip({ sessionId: "s1" })

    await userEvent.click(screen.getByTestId("composition-chip"))
    await userEvent.click(await screen.findByRole("combobox", { name: /preset/i }))
    await userEvent.click(await screen.findByRole("option", { name: /Minimal/ }))

    const state = useAgentRuntimeStore.getState()
    expect(state.sessionCompositions.s1.presetId).toBe("minimal")
    expect(state.defaultComposition.presetId).toBe("standard")
  })

  it("writes to the app default when there is no session yet", async () => {
    renderChip({})

    await userEvent.click(screen.getByTestId("composition-chip"))
    await userEvent.click(await screen.findByRole("combobox", { name: /preset/i }))
    await userEvent.click(await screen.findByRole("option", { name: /Minimal/ }))

    const state = useAgentRuntimeStore.getState()
    expect(state.defaultComposition.presetId).toBe("minimal")
    expect(state.sessionCompositions).toEqual({})
  })

  // The old dropdown could not name these at all: they have no
  // `AgentModeConfig`, so it fell back to "General Assistant".
  it("names a preset that has no legacy mode record behind it", () => {
    act(() => {
      useAgentRuntimeStore.setState({ sessionCompositions: { s1: { presetId: "minimal" } } })
    })

    renderChip({ sessionId: "s1" })
    expect(screen.getByTestId("composition-chip")).not.toHaveTextContent("General")
    expect(screen.getByTestId("composition-chip")).toHaveTextContent("Minimal")
  })

  it("offers a user's custom mode", async () => {
    act(() => {
      useCustomModeStore.setState({
        customModes: {
          "my-reviewer": {
            id: "my-reviewer",
            type: "custom",
            name: "My Reviewer",
            description: "Reviews things",
            icon: "Sparkles",
            isBuiltIn: false,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        } as never,
      })
    })

    renderChip({ sessionId: "s1" })
    await userEvent.click(screen.getByTestId("composition-chip"))
    await userEvent.click(await screen.findByRole("combobox", { name: /preset/i }))

    expect(await screen.findByRole("option", { name: /My Reviewer/ })).toBeInTheDocument()
  })

  it("marks the chip when the composition was narrowed for this turn", () => {
    act(() => {
      useAgentRuntimeStore.setState({
        sessionCompositions: { s1: { presetId: "minimal", authority: "bypassPermissions" } },
      })
    })

    renderChip({ sessionId: "s1" })

    expect(screen.getByTestId("composition-chip-warning-dot")).toBeInTheDocument()
    expect(screen.getByTestId("composition-chip")).toHaveAttribute("data-narrowed", "true")
  })

  it("carries no warning marker for an unnarrowed composition", () => {
    renderChip({ sessionId: "s1" })

    expect(screen.queryByTestId("composition-chip-warning-dot")).not.toBeInTheDocument()
  })

  it("cannot be opened while a turn is streaming", () => {
    renderChip({ sessionId: "s1", disabled: true })

    expect(screen.getByTestId("composition-chip")).toBeDisabled()
  })

  describe("split layout", () => {
    it("lists presets straight from the row and writes the choice to the session", async () => {
      renderChip({ sessionId: "s1", layout: "split" })

      await userEvent.click(screen.getByTestId("composition-chip"))
      await userEvent.click(await screen.findByRole("menuitemradio", { name: /Minimal/ }))

      const state = useAgentRuntimeStore.getState()
      expect(state.sessionCompositions.s1.presetId).toBe("minimal")
      expect(state.defaultComposition.presetId).toBe("standard")
    })

    it("keeps the preset selection when an axis is pinned from the advanced panel", async () => {
      renderChip({ sessionId: "s1", layout: "split" })

      await userEvent.click(screen.getByTestId("composition-advanced-trigger"))
      // No preset selector inside — the row already has one.
      expect(screen.queryByRole("combobox", { name: /preset/i })).not.toBeInTheDocument()

      await userEvent.click(await screen.findByRole("combobox", { name: /permission/i }))
      await userEvent.click(await screen.findByRole("option", { name: "Read-only" }))

      expect(useAgentRuntimeStore.getState().sessionCompositions.s1).toEqual({
        presetId: "standard",
        authority: "plan",
      })
    })

    it("counts pinned axes on the advanced button", () => {
      act(() => {
        useAgentRuntimeStore.setState({
          sessionCompositions: { s1: { presetId: "standard", authority: "plan" } },
        })
      })

      renderChip({ sessionId: "s1", layout: "split" })

      expect(screen.getByTestId("composition-advanced-count")).toHaveTextContent("1")
      expect(screen.getByTestId("composition-advanced-trigger")).toHaveAttribute(
        "data-overrides",
        "1"
      )
    })

    it("shows no count when every axis follows the preset", () => {
      renderChip({ sessionId: "s1", layout: "split" })

      expect(screen.queryByTestId("composition-advanced-count")).not.toBeInTheDocument()
    })

    it("marks the preset chip when the composition was narrowed", () => {
      act(() => {
        useAgentRuntimeStore.setState({
          sessionCompositions: { s1: { presetId: "minimal", authority: "bypassPermissions" } },
        })
      })

      renderChip({ sessionId: "s1", layout: "split" })

      expect(screen.getByTestId("composition-chip")).toHaveAttribute("data-narrowed", "true")
      expect(screen.getByTestId("composition-chip-warning-dot")).toBeInTheDocument()
    })

    it("hides developer-only presets from the row menu unless developer mode is on", async () => {
      renderChip({ sessionId: "s1", layout: "split" })

      await userEvent.click(screen.getByTestId("composition-chip"))

      expect(await screen.findByRole("menuitemradio", { name: /Standard/ })).toBeInTheDocument()
      expect(screen.queryByRole("menuitemradio", { name: /Creator/ })).not.toBeInTheDocument()
    })

    it("disables both controls while a turn is streaming", () => {
      renderChip({ sessionId: "s1", layout: "split", disabled: true })

      expect(screen.getByTestId("composition-chip")).toBeDisabled()
      expect(screen.getByTestId("composition-advanced-trigger")).toBeDisabled()
    })
  })
})

describe("CompositionChip — executor", () => {
  beforeEach(() => {
    executorState.squadId = null
    executorState.squadName = null
    executorState.squads = []
    executorState.select.mockClear()
  })

  it("shows the preset while the conversation runs on a single agent", () => {
    renderChip({ sessionId: "s1" })
    expect(screen.getByTestId("composition-chip")).toHaveTextContent("Standard")
  })

  it("names the Squad instead of the preset once one is bound", () => {
    // Which Squad is running this conversation outranks which preset shapes
    // one agent's prompt — the chip has room for one of them.
    executorState.squadId = "sq-1"
    executorState.squadName = "Research Squad"
    renderChip({ sessionId: "s1" })
    expect(screen.getByTestId("composition-chip")).toHaveTextContent("Research Squad")
  })

  it("flags a binding whose Squad is gone rather than falling back silently", () => {
    executorState.squadId = "deleted"
    executorState.squadName = null
    renderChip({ sessionId: "s1" })
    const chip = screen.getByTestId("composition-chip")
    expect(chip).toHaveTextContent("Squad unavailable")
    expect(chip).toHaveAttribute("data-narrowed", "true")
  })
})

describe("CompositionChip shells", () => {
  beforeEach(() => {
    useIsMobileMock.mockReset().mockReturnValue(false)
  })

  it("carries the overlay tier on the combined panel", async () => {
    renderChip({ sessionId: "s1", layout: "combined" })
    await userEvent.click(screen.getByTestId("composition-chip"))
    expect(screen.getByTestId("composition-panel")).toHaveAttribute("data-surface-layer", "overlay")
  })

  it("opens the combined panel as a bottom sheet on a phone", async () => {
    useIsMobileMock.mockReturnValue(true)
    renderChip({ sessionId: "s1", layout: "combined" })
    await userEvent.click(screen.getByTestId("composition-chip"))
    expect(screen.getByTestId("composition-panel")).toHaveAttribute("data-slot", "drawer-content")
    // The executor list and the axes are both still in there.
    expect(screen.getByTestId("executor-choice-list")).toBeInTheDocument()
  })

  it("carries the tier on the wide row's advanced panel too", async () => {
    renderChip({ sessionId: "s1", layout: "split" })
    await userEvent.click(screen.getByTestId("composition-advanced-trigger"))
    expect(screen.getByTestId("composition-advanced-panel")).toHaveAttribute(
      "data-surface-layer",
      "overlay"
    )
  })
})
