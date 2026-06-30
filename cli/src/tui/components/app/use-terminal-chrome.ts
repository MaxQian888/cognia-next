import { useEffect, useMemo, useRef } from "react"
import type { Dispatch } from "react"
import type { TuiAction } from "../../state/types"
import {
  enterAltScreen,
  exitAltScreen,
  applyMouseMode,
  resetMouse,
  type ScreenStream,
} from "../../screen"
import {
  applyTerminalTitle,
  resetTerminalTitle,
  computeTitle,
  type TitleStream,
  type TitleEnv,
} from "../../terminal-title"
import { emitCompletionBell, shouldNotifyOnDone } from "../../notify"
import type { MouseMode } from "../../../config/schema"
import { baseName, RESIZE_DEBOUNCE_MS } from "./app-helpers"

/** Resize-event surface the repaint effect needs off the Ink stdout. */
interface ResizeStdout {
  on?: (event: "resize", cb: () => void) => void
  off?: (event: "resize", cb: () => void) => void
}

export interface TerminalChromeOptions {
  /** Effective layout — only fullscreen owns the alt-screen + mouse + skips resize repaint. */
  fullscreen: boolean
  /** Sink for the alt-screen enter/exit + mouse escapes. */
  screen: ScreenStream
  /** Fullscreen mouse model (select | scroll); seeded once into the alt buffer. */
  mouseMode: MouseMode
  /** True when `mount.tsx` already entered + cleared the alt screen before Ink's
   * first paint, so the effect must skip the redundant (frame-wiping) re-enter. */
  altScreenPreEntered?: boolean
  /** Ink stdout — drives the scrollback resize repaint. */
  stdout: ResizeStdout | undefined
  /** Terminal wiper for the resize repaint. */
  clearScreen: () => void
  dispatch: Dispatch<TuiAction>
  /** Whether the dynamic terminal title is enabled (`config.terminalTitle !== false`). */
  titleEnabled: boolean
  /** Sink for the title escapes (kept distinct from `screen`). */
  titleSink: TitleStream
  /** Env slice steering terminal-title adaptation (tmux / screen / dumb). */
  titleEnv?: TitleEnv
  /** Whether a turn is in flight (drives the title + the completion bell gate). */
  busy: boolean
  /** Whether a turn-blocking prompt (permission / ask_user) is awaiting the user. */
  awaitingInput: boolean
  /** Active background-runtime activity kind, when running. */
  activityKind: string | undefined
  /** Working directory — its basename is the title's project caption. */
  cwd: string
  /** Whether the completion bell is enabled (`config.notify === true`). */
  notifyEnabled: boolean
  /** Injected clock (deterministic under test) for the bell's elapsed-time gate. */
  now: () => number
}

/**
 * Terminal-integration effects, lifted out of {@link App}: the alternate-screen
 * + mouse lifecycle, the dynamic window/tab title, the opt-in completion bell,
 * and the scrollback-mode resize repaint. Each is a self-contained effect that
 * only reads its inputs, so the cluster tests in isolation without a live TTY.
 */
export function useTerminalChrome(opts: TerminalChromeOptions): void {
  const {
    fullscreen,
    screen,
    mouseMode,
    altScreenPreEntered,
    stdout,
    clearScreen,
    dispatch,
    titleEnabled,
    titleSink,
    titleEnv,
    busy,
    awaitingInput,
    activityKind,
    cwd,
    notifyEnabled,
    now,
  } = opts

  // Tracks whether the alternate screen is already active. Seeded from
  // `altScreenPreEntered` so the effect knows when `mount.tsx` already entered +
  // cleared the alt buffer BEFORE Ink's first paint: re-entering here would
  // re-issue CLEAR_HOME and wipe the frame Ink just drew. Skipping the redundant
  // enter keeps the first frame on screen while still owning enter/exit for live
  // `/layout` toggles (and for tests, which render App directly with no pre-enter).
  const altScreenActive = useRef(Boolean(altScreenPreEntered) && fullscreen)
  useEffect(() => {
    if (!fullscreen) return
    if (!altScreenActive.current) {
      enterAltScreen(screen)
      // Mouse handling lives with the alt-screen lifecycle: it is only meaningful
      // (and only safe) while fullscreen owns the screen. A live `/mouse` toggle
      // re-applies imperatively in `applyEffect` — this only seeds the initial mode.
      applyMouseMode(mouseMode, screen)
      altScreenActive.current = true
    }
    return () => {
      resetMouse(screen)
      exitAltScreen(screen)
      altScreenActive.current = false
    }
    // `mouseMode` is intentionally NOT a dep: the initial application is gated by
    // `altScreenActive`, and live changes go through `applyEffect` so a re-enter
    // never re-issues CLEAR_HOME. eslint-disable to keep the effect enter-once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, screen])

  // Dynamic terminal title: reflect the live session state in the window / tab
  // caption. Independent of the alt-screen layout (works in scrollback too), so
  // it writes to its own sink and is terminal-type-adapted by the module.
  const titleText = useMemo(
    () =>
      computeTitle({
        busy,
        awaitingInput,
        activity: activityKind,
        dir: baseName(cwd),
      }),
    [busy, awaitingInput, activityKind, cwd]
  )
  useEffect(() => {
    if (titleEnabled) applyTerminalTitle(titleText, titleSink, titleEnv)
  }, [titleEnabled, titleText, titleSink, titleEnv])
  // Restore the terminal's default title on unmount (the per-state apply above
  // owns live updates; this is the teardown so we never strand a stale caption).
  useEffect(() => {
    if (!titleEnabled) return
    return () => resetTerminalTitle(titleSink, titleEnv)
  }, [titleEnabled, titleSink, titleEnv])

  // Completion bell (opt-in via `config.notify`): ring the terminal bell when a
  // turn finishes so you can tab away during a long run and be alerted. Gated on
  // the turn's elapsed time so a quick reply doesn't beep. The `now` clock is
  // injected, so the busy→idle transition + duration gate are deterministic.
  const turnStartRef = useRef<number | null>(null)
  const prevBusyRef = useRef(false)
  useEffect(() => {
    if (busy && !prevBusyRef.current) {
      turnStartRef.current = now()
    } else if (!busy && prevBusyRef.current) {
      const elapsed = turnStartRef.current !== null ? now() - turnStartRef.current : 0
      turnStartRef.current = null
      if (shouldNotifyOnDone(notifyEnabled, elapsed)) emitCompletionBell(titleSink, titleEnv)
    }
    prevBusyRef.current = busy
  }, [busy, notifyEnabled, now, titleSink, titleEnv])

  // Terminal resize recovery (scrollback mode only). `<Static>` wrote the
  // transcript into the scrollback at the OLD width; on resize Ink reflows its
  // live frame over that stale content, smearing the layout. Clear the screen and
  // bump the render epoch so `<Static>` remounts and re-prints every cell at the
  // new width — debounced so a drag doesn't thrash. In fullscreen there is no
  // `<Static>`; Ink reflows the bounded frame on its own, so skip it entirely.
  const repaintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!stdout?.on || fullscreen) return
    const onResize = () => {
      if (repaintTimer.current) clearTimeout(repaintTimer.current)
      repaintTimer.current = setTimeout(() => {
        repaintTimer.current = null
        clearScreen()
        dispatch({ type: "REPAINT" })
      }, RESIZE_DEBOUNCE_MS)
    }
    stdout.on("resize", onResize)
    return () => {
      stdout.off?.("resize", onResize)
      if (repaintTimer.current) {
        clearTimeout(repaintTimer.current)
        repaintTimer.current = null
      }
    }
  }, [stdout, clearScreen, fullscreen, dispatch])
}
