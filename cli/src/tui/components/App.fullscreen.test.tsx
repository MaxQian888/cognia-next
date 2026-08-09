import path from "node:path"
import React from "react"
import { act, render, waitFor } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

jest.mock("../input/history-store", () => ({
  appendHistory: jest.fn(),
  loadHistory: jest.fn(() => []),
}))
jest.mock("../runtime/model-meta", () => ({
  resolveModelMeta: () => new Promise(() => {}),
}))

import { App } from "./App"
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  ALT_SCROLL_OFF,
  CLEAR_HOME,
  HIDE_CURSOR,
  SHOW_CURSOR,
  MOUSE_TRACK_OFF,
  MOUSE_TRACK_ON,
  MOUSE_DRAG_OFF,
  type ScreenStream,
} from "../screen"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { CreateSession } from "../hooks/useAgentSession"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  model: "claude-x",
  providers: { anthropic: { model: "claude-x" } },
  cwd: path.resolve("/work"),
}

const result = (text: string): RunAndCaptureResult => ({
  text,
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
})

function fakeSession(answer = "the answer") {
  const create: CreateSession = () => ({
    sessionId: "ses-fake",
    async send(prompt, opts) {
      opts.onEvent?.({ type: "text-delta", delta: answer })
      return result(answer)
    },
    close: jest.fn(),
  })
  return { create }
}

/** A screen sink that records the escapes the alt-screen lifecycle writes. */
function fakeScreen(): { screen: ScreenStream; writes: string[] } {
  const writes: string[] = []
  return { screen: { isTTY: true, write: (d) => writes.push(d) }, writes }
}

const FULLSCREEN_CAP = { stdoutIsTTY: true, stdinIsTTY: true, term: "xterm" }

describe("App — fullscreen layout", () => {
  beforeEach(() => __resetInk())

  it("enters the alternate screen buffer on mount and exits on unmount", () => {
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    const { unmount } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )
    // Default config has no `mouse` set ⇒ "scroll": enable SGR wheel tracking so
    // the wheel scrolls the transcript out of the box.
    // `selection` defaults to off ⇒ drag reporting is released FIRST, so the
    // tracking enable is the last word (the three modes share one slot in the
    // terminal — a trailing reset would disable the wheel outright).
    expect(writes).toEqual([ALT_SCREEN_ON, CLEAR_HOME, HIDE_CURSOR, MOUSE_DRAG_OFF, MOUSE_TRACK_ON])
    unmount()
    expect(writes).toEqual([
      ALT_SCREEN_ON,
      CLEAR_HOME,
      HIDE_CURSOR,
      MOUSE_DRAG_OFF,
      MOUSE_TRACK_ON,
      MOUSE_DRAG_OFF,
      MOUSE_TRACK_OFF,
      ALT_SCREEN_OFF,
      SHOW_CURSOR,
    ])
  })

  it("does NOT re-enter/re-clear the alt screen on mount when mount.tsx already entered it", () => {
    // Production fullscreen path: `mount.tsx` entered + cleared the alt buffer
    // BEFORE Ink's first paint and passes `altScreenPreEntered`. Re-issuing
    // CLEAR_HOME after the paint would wipe the first frame (blank-until-resize),
    // so the App must skip the redundant enter on mount — but still exit on unmount.
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    const { unmount } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
        altScreenPreEntered
      />
    )
    expect(writes).toEqual([])
    unmount()
    expect(writes).toEqual([MOUSE_DRAG_OFF, MOUSE_TRACK_OFF, ALT_SCREEN_OFF, SHOW_CURSOR])
  })

  it("renders the fixed banner with a live status line (mode + context)", () => {
    const { screen } = fakeScreen()
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Cognia Agent")
    // The enriched fixed header renders the context segment (0% with no usage),
    // which the scrollback banner never shows.
    expect(text).toContain("0% ctx")
    expect(text).toContain("default")
  })

  it("still streams an answer in fullscreen mode", async () => {
    const { screen } = fakeScreen()
    const { create } = fakeSession("hello fullscreen")
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )
    act(() => __fireInput("h"))
    act(() => __fireInput("i"))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("hello fullscreen"))
  })

  it("lets an open overlay occupy the remaining fullscreen viewport", () => {
    const { screen } = fakeScreen()
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )

    act(() => __fireInput("/"))
    for (const ch of "help") act(() => __fireInput(ch))
    act(() => __fireInput("", { return: true }))

    const overlayRegion = container.querySelector('[data-testid="fullscreen-overlay-region"]')
    expect(overlayRegion).not.toBeNull()
    expect(overlayRegion).toHaveAttribute("data-flex-grow", "1")
    expect(overlayRegion).toHaveTextContent("Commands")
  })

  it("scroll mode captures the wheel via SGR tracking without inserting the escape", () => {
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={{ ...config, mouse: "scroll" }}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )
    // Scroll mode enables button tracking so the wheel reaches the App — and
    // the enable comes last, so nothing resets it back off.
    expect(writes).toEqual([ALT_SCREEN_ON, CLEAR_HOME, HIDE_CURSOR, MOUSE_DRAG_OFF, MOUSE_TRACK_ON])
    // SGR wheel-up / wheel-down reports as Ink surfaces them (leading ESC stripped).
    expect(() => {
      act(() => __fireInput("[<64;10;5M"))
      act(() => __fireInput("[<65;10;5M"))
    }).not.toThrow()
    // The raw mouse escape must never land in the composer as literal text.
    expect(container.textContent ?? "").not.toContain("[<64")
    expect(container.textContent ?? "").not.toContain("[<65")
  })

  it("select mode swallows a stray wheel report instead of inserting it", () => {
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={{ ...config, mouse: "select" }}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )
    // Select mode releases drag reporting + tracking, then suppresses
    // alternate-scroll (no wheel SGR).
    expect(writes).toEqual([
      ALT_SCREEN_ON,
      CLEAR_HOME,
      HIDE_CURSOR,
      MOUSE_DRAG_OFF,
      MOUSE_TRACK_OFF,
      ALT_SCROLL_OFF,
    ])
    expect(() => {
      act(() => __fireInput("[<64;10;5M"))
      act(() => __fireInput("[<65;10;5M"))
    }).not.toThrow()
    expect(container.textContent ?? "").not.toContain("[<64")
    expect(container.textContent ?? "").not.toContain("[<65")
  })

  it("Ctrl+F opens find-in-viewport, matches the transcript, and Esc closes", async () => {
    const { screen } = fakeScreen()
    const { create } = fakeSession("hello fullscreen")
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )
    // Produce a transcript: a committed user cell ("hi") + the assistant reply.
    act(() => __fireInput("h"))
    act(() => __fireInput("i"))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("hello fullscreen"))
    // Ctrl+F opens the find bar with an empty query.
    act(() => __fireInput("f", { ctrl: true }))
    expect(container.textContent).toContain("type to search")
    // Typing narrows to the single user cell that contains "hi".
    act(() => __fireInput("h"))
    act(() => __fireInput("i"))
    expect(container.textContent).toContain("1/1")
    // Esc closes the bar.
    act(() => __fireInput("", { escape: true }))
    expect(container.textContent).not.toContain("type to search")
  })

  it("handles PgUp / PgDn without error in fullscreen", () => {
    const { screen } = fakeScreen()
    const { create } = fakeSession()
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )
    expect(() => {
      act(() => __fireInput("", { pageUp: true }))
      act(() => __fireInput("", { pageDown: true }))
    }).not.toThrow()
  })

  it("does NOT touch the alternate screen in scrollback mode", () => {
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    const { unmount } = render(
      <App
        config={{ ...config, layout: "scrollback" }}
        sessionId="s1"
        createSession={create}
        layoutCapability={FULLSCREEN_CAP}
        screenOut={screen}
      />
    )
    unmount()
    expect(writes).toEqual([])
  })

  it("falls back to scrollback (no alt-screen) on a non-TTY terminal even when fullscreen is set", () => {
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    render(
      <App
        config={{ ...config, layout: "fullscreen" }}
        sessionId="s1"
        createSession={create}
        layoutCapability={{ stdoutIsTTY: false, stdinIsTTY: false }}
        screenOut={screen}
      />
    )
    expect(writes).toEqual([])
  })
})

describe("App — dynamic terminal title", () => {
  beforeEach(() => __resetInk())

  const OSC = (t: string) => `\x1b]0;${t}\x07`

  it("sets an idle title with the cwd basename on mount and clears it on unmount", () => {
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    const { unmount } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        titleOut={screen}
        titleEnv={{ TERM: "xterm" }}
      />
    )
    expect(writes[0]).toBe(OSC("cognia - work"))
    unmount()
    expect(writes[writes.length - 1]).toBe(OSC(""))
  })

  it("does not write a title when disabled via config", () => {
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    render(
      <App
        config={{ ...config, terminalTitle: false }}
        sessionId="s1"
        createSession={create}
        titleOut={screen}
        titleEnv={{ TERM: "xterm" }}
      />
    )
    expect(writes).toEqual([])
  })

  it("adapts the title sequence for a tmux session", () => {
    const { screen, writes } = fakeScreen()
    const { create } = fakeSession()
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        titleOut={screen}
        titleEnv={{ TMUX: "/tmp/tmux-1000/default,1,0" }}
      />
    )
    expect(writes[0]).toBe(`\x1bkcognia - work\x1b\\${OSC("cognia - work")}`)
  })
})
