/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ChatSession } from "@cognia/agent-config-types"

import { __resetBreakerForTesting } from "@/lib/router-fusion/gate/breaker"
import { useChatFusionModeStore } from "@/stores/chat/fusion-mode-store"

import { COMPOSER_TOOLBAR_CHIP } from "@/lib/chat/composer-skin"
import { FusionModeChip } from "./fusion-mode-chip"

let mockTauri = true
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: () => mockTauri,
}))

let mockSettings: unknown = null
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (state: { settings: unknown }) => T) =>
    selector({ settings: mockSettings }),
}))

const ON = { routerFusion: { enabled: true, surfaces: { chat: true } } }
const OFF_MASTER = { routerFusion: { enabled: false, surfaces: { chat: true } } }
const PAUSED = {
  routerFusion: {
    enabled: true,
    surfaces: { chat: true },
    trippedSurfaces: { chat: { trippedAt: 1, reason: "db_unavailable" } },
  },
}

const session = { id: "s1", title: "t", createdAt: 1, updatedAt: 1 } as ChatSession

// Radix tooltips throw without a provider — app/layout mounts one in production.
const renderChip = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

beforeEach(() => {
  mockTauri = true
  mockSettings = ON
  __resetBreakerForTesting()
  localStorage.clear()
  useChatFusionModeStore.setState({ modes: {} })
})

describe("FusionModeChip", () => {
  it("[ACC:OFF-02] renders nothing while Router + Fusion chat is off", () => {
    for (const settings of [
      null,
      {},
      OFF_MASTER,
      { routerFusion: { enabled: true, surfaces: {} } },
    ]) {
      mockSettings = settings
      const view = renderChip(<FusionModeChip session={session} builtinRuntime />)
      expect(screen.queryByTestId("fusion-mode-chip")).toBeNull()
      view.unmount()
    }
  })

  it("renders nothing where the send path would ignore the choice", () => {
    const cases: Array<[ChatSession | null, boolean, boolean]> = [
      [null, true, true],
      [session, false, true],
      [session, true, false],
      [{ ...session, kind: "workflow-editor" } as ChatSession, true, true],
    ]
    for (const [candidate, builtin, tauri] of cases) {
      mockTauri = tauri
      const view = renderChip(<FusionModeChip session={candidate} builtinRuntime={builtin} />)
      expect(screen.queryByTestId("fusion-mode-chip")).toBeNull()
      view.unmount()
    }
  })

  it("shows Auto as a glyph and records the conversation's choice", async () => {
    const user = userEvent.setup()
    renderChip(<FusionModeChip session={session} builtinRuntime />)
    const chip = screen.getByTestId("fusion-mode-chip")
    expect(chip).toHaveAttribute("data-mode", "auto")
    expect(chip).toHaveAccessibleName("Router + Fusion run mode: Auto")
    expect(chip).not.toHaveTextContent("Auto")

    await user.click(chip)
    const menu = await screen.findByTestId("fusion-mode-menu")
    expect(menu).toHaveTextContent(
      "Direct, unless a cascade or panel rule you approved matches the turn."
    )
    expect(menu).toHaveTextContent("Cascade and panel answers appear once they are verified.")
    expect(menu).not.toHaveTextContent("paused")
    await user.click(screen.getByTestId("fusion-mode-panel"))

    expect(useChatFusionModeStore.getState().modes).toEqual({ s1: "panel" })
    const labelled = screen.getByTestId("fusion-mode-chip")
    expect(labelled).toHaveAttribute("data-mode", "panel")
    expect(labelled).toHaveTextContent("Panel")
  })

  it("flags an explicit mode while chat is paused, since such a turn is refused", async () => {
    const user = userEvent.setup()
    mockSettings = PAUSED
    useChatFusionModeStore.getState().setMode("s1", "cascade")
    renderChip(<FusionModeChip session={session} builtinRuntime />)
    const chip = screen.getByTestId("fusion-mode-chip")
    expect(chip.className).toContain("text-warning")
    await user.click(chip)
    expect(await screen.findByTestId("fusion-mode-paused")).toHaveTextContent(
      "Cascade and Panel turns are refused until you re-arm it"
    )
  })

  // The toolbar's fold tier 2 glyphs every per-turn chip — a non-auto mode
  // still reads through the icon flag and the accessible name.
  it("drops a non-default mode's label but keeps the flag in glyph form", () => {
    useChatFusionModeStore.getState().setMode("s1", "cascade")
    renderChip(<FusionModeChip session={session} builtinRuntime glyph />)
    const chip = screen.getByTestId("fusion-mode-chip")
    expect(chip).toHaveAttribute("data-mode", "cascade")
    expect(chip).not.toHaveTextContent("Cascade")
    expect(chip).toHaveAccessibleName("Router + Fusion run mode: Cascade")
    expect(chip.className).toContain("w-7")
  })

  it("keeps the paused flag's tint under the toolbar's chip class", () => {
    mockSettings = PAUSED
    useChatFusionModeStore.getState().setMode("s1", "cascade")
    renderChip(
      <FusionModeChip session={session} builtinRuntime glyph className={COMPOSER_TOOLBAR_CHIP} />
    )
    const chip = screen.getByTestId("fusion-mode-chip")
    expect(chip.className).toContain("text-warning")
    expect(chip.className).not.toMatch(/(^|\s)text-muted-foreground(\s|$)/)
    expect(chip.className).toMatch(/(^|\s)px-0(\s|$)/)
  })

  it("cannot be opened while a turn is in flight", () => {
    renderChip(<FusionModeChip session={session} builtinRuntime disabled />)
    expect(screen.getByTestId("fusion-mode-chip")).toBeDisabled()
  })
})
