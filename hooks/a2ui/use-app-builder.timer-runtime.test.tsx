/**
 * End-to-end regression for the generated Pomodoro mini-app (Tauri audit,
 * Round 11): "AI Generate" with no reachable model falls back to the template
 * generator, and pressing Start left the timer on 00:00.
 *
 * Nothing here is mocked except the clock: the real fallback generator, the
 * real A2UI store, the real `useA2UIAppBuilder`, the app-wide
 * `<A2UIBuiltInActionsProvider>`, and the real surface renderer. The button is
 * clicked in the DOM, so the click travels the same path as a user's:
 * A2UIButton → A2UIProvider.emitAction → store.emitAction → global emitter →
 * built-in handler → surface timer runtime → store → re-render.
 */

import { useState } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import { A2UIBuiltInActionsProvider } from "@/components/providers/a2ui-built-in-actions-provider"
import { A2UIInlineSurface } from "@/components/a2ui/a2ui-surface"
import { canReachModel, generateA2UIApp } from "@/lib/a2ui/ai-generate"
import { surfaceTimers } from "@/lib/a2ui/surface-timer"
import { globalEventEmitter } from "@/lib/a2ui/events"
import { useA2UIStore } from "@/stores/a2ui"
import { useA2UIAppBuilder } from "./use-app-builder"

function GeneratedMiniApp({ instruction }: { instruction: string }) {
  const builder = useA2UIAppBuilder()
  const [surfaceId, setSurfaceId] = useState<string | null>(null)

  if (surfaceId) return <A2UIInlineSurface surfaceId={surfaceId} />
  return (
    <button
      type="button"
      onClick={async () => {
        // Same sequence as the /a2ui hub's "AI Generate" (app/a2ui/page.tsx).
        const result = await generateA2UIApp({ instruction, mode: "create" })
        setSurfaceId(builder.createCustomApp(result.title, result.components, result.dataModel))
      }}
    >
      generate
    </button>
  )
}

async function renderGenerated(instruction: string) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <A2UIBuiltInActionsProvider />
      <GeneratedMiniApp instruction={instruction} />
    </NextIntlClientProvider>
  )
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "generate" }))
  })
  return view
}

function dataModel(): Record<string, unknown> {
  const { surfaces } = useA2UIStore.getState()
  const surfaceId = Object.keys(surfaces)[0]
  return surfaces[surfaceId]?.dataModel ?? {}
}

function display(): string {
  return String(dataModel().display)
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms)
  })
}

describe("generated Pomodoro mini-app (real runtime)", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    window.localStorage.clear()
    useA2UIStore.getState().reset()
  })

  afterEach(() => {
    surfaceTimers.stopAll()
    globalEventEmitter.clear()
    jest.useRealTimers()
  })

  it("uses the no-model template fallback in this environment", () => {
    expect(canReachModel()).toBe(false)
  })

  it("opens on the 25:00 work block instead of 00:00", async () => {
    await renderGenerated("Pomodoro Timer")
    expect(screen.getByText("25:00")).toBeInTheDocument()
  })

  it("counts down after Start, then Pause freezes and Reset rewinds", async () => {
    await renderGenerated("Pomodoro Timer")

    fireEvent.click(screen.getByRole("button", { name: /start/i }))
    advance(8_000)
    expect(screen.getByText("24:52")).toBeInTheDocument()
    expect(dataModel().isRunning).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: /pause/i }))
    advance(5_000)
    expect(display()).toBe("24:52")

    // Resume continues from the paused position, not from the top.
    fireEvent.click(screen.getByRole("button", { name: /start/i }))
    advance(2_000)
    expect(display()).toBe("24:50")

    fireEvent.click(screen.getByRole("button", { name: /reset/i }))
    advance(3_000)
    expect(screen.getByText("25:00")).toBeInTheDocument()
    expect(surfaceTimers.size).toBe(0)
  })

  it("preset buttons load a new length that Start then counts down", async () => {
    const { container } = await renderGenerated("Pomodoro Timer")

    fireEvent.click(within(container).getByRole("button", { name: /break 5/i }))
    expect(display()).toBe("05:00")
    fireEvent.click(screen.getByRole("button", { name: /start/i }))
    advance(61_000)
    expect(display()).toBe("03:59")
  })

  it("the plain timer generator ticks too", async () => {
    await renderGenerated("make a 1 minute countdown timer")
    expect(display()).toBe("01:00")
    fireEvent.click(screen.getByRole("button", { name: /start/i }))
    advance(60_500)
    expect(display()).toBe("00:00")
    // The countdown finished: the run flag clears and the ticker is released.
    expect(dataModel().isRunning).toBe(false)
    expect(surfaceTimers.size).toBe(0)
  })
})
