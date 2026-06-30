import { useRef } from "react"
import { useInput, measureElement, type DOMElement } from "ink"
import type { MutableRefObject } from "react"

import { bufferText, bufferFromText } from "../../input/buffer"
import { clipboardFailureMessage } from "../../clipboard"
import { cellToText } from "../../format/scrollback-search"
import { parseMouseEvent } from "../../input/mouse"
import { runningSubagents } from "../../format/subagent"
import { countRunningCliBackgroundRuns } from "../../../agent/subagent-background-tasks"
import { absoluteTopLeft } from "../../input/element-position"
import { segmentAtColumn } from "../../format/status-bar-hit"
import { footerSegmentCommand } from "../../format/footer-action"
import { cyclePermissionMode } from "../../input/mode-cycle"
import { deriveEffortSliderState } from "../../../config/thinking"
import { matchAction } from "../../input/keybindings"
import { lastAssistantText } from "../../state/selectors"
import { collectInspectables } from "../../runtime/inspect"
import { buildStepInspectorDoc } from "../../runtime/workflow-step-doc"
import { DOUBLE_CTRL_C_MS, WHEEL_SCROLL_LINES } from "./app-helpers"
import type { TuiState, TuiAction } from "../../state/types"
import type { Dispatch } from "react"
import type { ScrollController } from "../../hooks/useScroll"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { AskUserOverlayApi } from "../../hooks/use-ask-user-overlay"
import type { StatusSegmentView } from "../../format/status-bar"
import type { resolveKeybindings } from "../../input/keybindings"
import type { MouseMode, ResolvedNotices, ResolvedRenderConfig } from "../../../config/schema"
import type { CopyResult } from "../../clipboard"

/**
 * Inputs the global key handler reads off the App. They are read fresh on every
 * keypress (Ink re-registers the handler each render), so no memoization or deps
 * array is needed — passing the latest values is enough.
 */
export interface GlobalKeysDeps {
  state: TuiState
  dispatch: Dispatch<TuiAction>
  overlayOpen: boolean
  busy: boolean
  fullscreen: boolean
  mouseMode: MouseMode
  notices: ResolvedNotices
  keybindings: ReturnType<typeof resolveKeybindings>
  renderPrefs: ResolvedRenderConfig
  now: () => number
  doExit: () => void
  agent: AgentSessionApi
  abortRuntime: () => void
  askUser: AskUserOverlayApi
  hasForegroundRun: () => boolean
  killForegroundBash: () => boolean
  backgroundForegroundBash: () => boolean
  copyClipboard: (text: string) => Promise<CopyResult>
  runCommandLine: (line: string) => void
  openModelPicker: () => void
  persist: (key: string, value: string) => boolean
  pasteClipboardImage: () => Promise<void>
  scrollReset: () => void
  disarmBacktrack: () => void
  armBacktrack: () => void
  cursor: TranscriptCursor
  scroll: ScrollController
  clearScreen: () => void
  composerPopupOpen: MutableRefObject<boolean>
  subagentChipRef: MutableRefObject<DOMElement | null>
  footerRowRef: MutableRefObject<DOMElement | null>
  footerSegmentsRef: MutableRefObject<StatusSegmentView[] | null>
  scrollContentRef: MutableRefObject<DOMElement | null>
  backtrackArmedRef: MutableRefObject<boolean>
}

/**
 * The TUI's global key handler, lifted out of {@link App}: the Ctrl+C
 * interrupt/exit ladder, find-in-viewport keys, backtrack-to-edit selection,
 * fullscreen scroll + mouse routing, the customizable chord actions, Shift+Tab
 * permission cycling, and the idle double-Esc backtrack. Behaviour is identical
 * to when it was inline — the body reads the same identifiers, now destructured
 * from `deps`.
 */
export function useGlobalKeys(deps: GlobalKeysDeps): void {
  // Owned here (not shared with App): clears the Ctrl+C double-press window after
  // the hint expires, so a single press doesn't linger waiting for a second.
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useInput((input, key) => {
    const {
      state,
      dispatch,
      overlayOpen,
      busy,
      fullscreen,
      mouseMode,
      notices,
      keybindings,
      renderPrefs,
      now,
      doExit,
      agent,
      abortRuntime,
      askUser,
      hasForegroundRun,
      killForegroundBash,
      backgroundForegroundBash,
      copyClipboard,
      runCommandLine,
      openModelPicker,
      persist,
      pasteClipboardImage,
      scrollReset,
      disarmBacktrack,
      armBacktrack,
      cursor,
      scroll,
      clearScreen,
      composerPopupOpen,
      subagentChipRef,
      footerRowRef,
      footerSegmentsRef,
      scrollContentRef,
      backtrackArmedRef,
    } = deps

    if (key.ctrl && input === "c") {
      // A Ctrl+C with draft text in the composer clears the draft first (Claude
      // Code behaviour) — it never interrupts the turn or counts toward exit.
      // Only an empty composer falls through to the interrupt / double-press-to-
      // exit ladder below. Guarded to the normal chat view: overlays own their
      // own keys and the startup gate handles its own input.
      if (state.phase === "chat" && !overlayOpen && bufferText(state.input.buffer).length > 0) {
        dispatch({ type: "INPUT_CLEAR" })
        // Cancel any half-armed "press again to exit" window so the cleared
        // draft doesn't leave a primed exit behind.
        if (ctrlCTimer.current) {
          clearTimeout(ctrlCTimer.current)
          ctrlCTimer.current = null
        }
        if (state.lastCtrlCAt) dispatch({ type: "CLEAR_CTRL_C" })
        return
      }
      // An empty composer with a foreground `!command` running: a single Ctrl+C
      // kills it (and its process tree) and never counts toward exit. This is the
      // escape hatch for a blocking command — a dev server, a watcher — that
      // would otherwise hold the terminal forever.
      if (state.phase === "chat" && !overlayOpen && hasForegroundRun()) {
        if (ctrlCTimer.current) {
          clearTimeout(ctrlCTimer.current)
          ctrlCTimer.current = null
        }
        if (state.lastCtrlCAt) dispatch({ type: "CLEAR_CTRL_C" })
        killForegroundBash()
        return
      }
      const at = now()
      if (state.lastCtrlCAt && at - state.lastCtrlCAt < DOUBLE_CTRL_C_MS) {
        // Clear the pending hint timer before we exit.
        if (ctrlCTimer.current) {
          clearTimeout(ctrlCTimer.current)
          ctrlCTimer.current = null
        }
        doExit()
      } else {
        dispatch({ type: "CTRL_C", at })
        if (busy) {
          agent.abort()
          abortRuntime()
          // A turn-blocking overlay (permission prompt / ask_user question) would
          // otherwise linger after the abort with an orphaned resolver. Close the
          // permission overlay; settle ask_user as cancelled so its store doesn't
          // immediately re-open it (the bridge re-fires on an unresolved prompt).
          if (state.overlay.kind === "permission") dispatch({ type: "OVERLAY_CLOSE" })
          else if (state.overlay.kind === "askUser")
            askUser.resolve({ selected: [], text: "", cancelled: true })
          dispatch({ type: "NOTICE", message: "Interrupted · Press Ctrl+C again to exit" })
        } else {
          dispatch({ type: "NOTICE", message: "Press Ctrl+C again to exit" })
        }
        // Clear the double-press window after 3 s so a single press doesn't
        // linger indefinitely — the next Ctrl+C restarts the cycle.
        if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current)
        ctrlCTimer.current = setTimeout(() => {
          ctrlCTimer.current = null
          dispatch({ type: "CLEAR_CTRL_C" })
        }, 3000)
      }
      return
    }
    // During the startup gate, only Ctrl+C (above) is honored — the gate owns
    // its own keys.
    if (state.phase === "startup") return
    // Find-in-viewport (Ctrl+F): while the find bar is open it owns all input —
    // printable keys extend the query (live incremental search), arrows / Enter
    // step matches, Ctrl+Y copies the focused match, Esc closes. The composer is
    // unmounted during find (see the render below), so this is the only consumer.
    if (cursor.state.find) {
      const find = cursor.state.find
      if (key.escape) {
        cursor.clear()
        clearScreen()
        return
      }
      if (key.return || key.downArrow) {
        cursor.next()
        return
      }
      if (key.upArrow) {
        cursor.prev()
        return
      }
      if (key.ctrl && input === "y") {
        const cell = cursor.focused
        if (cell) {
          void Promise.resolve(copyClipboard(cellToText(cell))).then((res) =>
            dispatch({
              type: "NOTICE",
              message: res.ok ? notices.copiedCell : clipboardFailureMessage(res.reason, notices),
            })
          )
        }
        return
      }
      if (key.backspace || key.delete) {
        cursor.setQuery(find.query.slice(0, -1))
        return
      }
      // A printable character extends the query; control/meta chords are ignored.
      if (input && !key.ctrl && !key.meta && !key.tab) {
        cursor.setQuery(find.query + input)
        return
      }
      return
    }
    // Backtrack-to-edit selection: the composer is inert (`disabled` below) while
    // a prior user message is highlighted. ↑/↓ walk between user messages, Esc
    // cancels, Enter (or typing) loads the message into the composer as the edit
    // target — submitting then forks the conversation there.
    if (state.backtrack) {
      const idx = state.backtrack.index
      const targetText = () => {
        const cell = state.cells[idx]
        return cell && cell.kind === "user" ? cell.text : ""
      }
      // Scrollback highlights via `<Static>`, which only repaints after a clear +
      // epoch bump. Wipe the screen here so the reducer's epoch bump re-prints the
      // transcript with the highlight at its new position. Fullscreen re-renders
      // live, so it needs no clear.
      const repaintHighlight = () => {
        if (!fullscreen) clearScreen()
      }
      if (key.upArrow) {
        repaintHighlight()
        dispatch({ type: "BACKTRACK_MOVE", dir: -1 })
        return
      }
      if (key.downArrow) {
        repaintHighlight()
        dispatch({ type: "BACKTRACK_MOVE", dir: 1 })
        return
      }
      if (key.escape) {
        repaintHighlight()
        dispatch({ type: "BACKTRACK_CANCEL" })
        return
      }
      if (key.return) {
        repaintHighlight()
        dispatch({ type: "INPUT_SET", buffer: bufferFromText(targetText()) })
        dispatch({ type: "BACKTRACK_COMMIT", index: idx })
        return
      }
      // Start typing to edit: load the message and append the typed character.
      if (input && !key.ctrl && !key.meta && !key.tab) {
        repaintHighlight()
        dispatch({ type: "INPUT_SET", buffer: bufferFromText(targetText() + input) })
        dispatch({ type: "BACKTRACK_COMMIT", index: idx })
        return
      }
      return
    }
    // Fullscreen scroll: PgUp/PgDn page the transcript viewport (conflict-free —
    // the composer ignores PageUp/PageDown, and overlays own input while open).
    // Reaching the bottom re-engages follow mode, so PgDn doubles as "jump to
    // latest". In scrollback mode the terminal's native scrollback handles this,
    // so these keys fall through untouched.
    if (fullscreen && !overlayOpen) {
      if (key.pageUp) {
        scroll.pageUp()
        return
      }
      if (key.pageDown) {
        scroll.pageDown()
        return
      }
      // Mouse reports only arrive in `scroll` mode (SGR tracking is on). Scroll
      // the transcript by a few lines per wheel notch; swallow every other mouse
      // event (clicks/releases) so it never reaches a text field as literal
      // characters. In `select` mode tracking is off, so any stray report is
      // still swallowed here rather than inserted.
      const mouse = parseMouseEvent(input)
      if (mouse) {
        // While the composer popup owns input, let it consume the wheel (it
        // scrolls the popup) instead of paging the transcript underneath.
        if (mouse.kind === "wheel" && mouseMode === "scroll" && !composerPopupOpen.current) {
          for (let i = 0; i < WHEEL_SCROLL_LINES; i++) {
            if (mouse.dir === "up") scroll.lineUp()
            else scroll.lineDown()
          }
        } else if (mouse.kind === "click") {
          // A click on the BottomStatus subagent chip opens the `/agents` panel
          // (parity with Ctrl+B). Only acts when an agent chip is actually shown
          // and the click lands on its row.
          const hasAgentChip =
            runningSubagents(state.inflight.tools) != null ||
            countRunningCliBackgroundRuns(state.sessionId) > 0
          if (hasAgentChip && subagentChipRef.current) {
            const pos = absoluteTopLeft(subagentChipRef.current)
            if (pos) {
              const height = measureElement(subagentChipRef.current).height || 1
              const clickRow = mouse.row - 1
              if (clickRow >= pos.top && clickRow < pos.top + height) runCommandLine("/agents")
            }
          }
          // A click on a footer segment opens its picker: model/provider → model
          // overlay, mode → cycle permission mode, thinking → effort slider.
          if (footerRowRef.current && footerSegmentsRef.current) {
            const pos = absoluteTopLeft(footerRowRef.current)
            if (pos && mouse.row - 1 === pos.top) {
              const id = segmentAtColumn(footerSegmentsRef.current, mouse.col - 1 - pos.left)
              if (id === "model" || id === "provider") {
                openModelPicker()
              } else if (id === "mode") {
                const next = cyclePermissionMode(state.config.permissionMode)
                persist("permissionMode", next)
                void agent.switchMode(next)
                dispatch({ type: "NOTICE", message: `Permission mode: ${next}` })
              } else if (id === "thinking") {
                dispatch({
                  type: "OVERLAY_OPEN",
                  overlay: {
                    kind: "effortSlider",
                    ...deriveEffortSliderState(state.config.thinkingLevel),
                  },
                })
              } else if (id) {
                // The remaining segments (cwd/ctx/git/tokens/cost/cache/ratelimit)
                // are a click-shortcut to the matching report command.
                const cmd = footerSegmentCommand(id)
                if (cmd) runCommandLine(cmd)
              }
            }
          }
          // A click on a collapsed tool/thinking card toggles just that cell
          // (the global Ctrl+T toggles all). Opt-in + fullscreen only: the row
          // map needs per-cell heights, which are only measured when the
          // click-to-expand pref keeps `cursor` measuring. The content box's
          // `marginTop={-offset}` already encodes the scroll position, so the
          // click row maps straight onto a content row.
          if (fullscreen && renderPrefs.clickToExpand && scrollContentRef.current) {
            const contentPos = absoluteTopLeft(scrollContentRef.current)
            if (contentPos) {
              const cellId = cursor.cellIdAtContentRow(mouse.row - 1 - contentPos.top)
              if (cellId) dispatch({ type: "TOGGLE_COLLAPSE", id: cellId })
            }
          }
        }
        return
      }
    }
    // Ctrl+T toggles tool/thinking output for the whole transcript (moved off
    // Ctrl+R, which now opens history search). The composer ignores unhandled
    // ctrl chords, and overlays own input while open, so this only fires in the
    // normal chat view. The transcript lives in `<Static>` (write-once), so clear
    // the screen and let the bumped epoch re-print every cell with the new
    // collapsed state.
    // Global chord actions are resolved through the (customizable) keybindings
    // table — see `input/keybindings.ts`. Each keeps its own guard; all are gated
    // on no-overlay so a modal owns input while open. Defaults reproduce the
    // historic chords (Ctrl+T/R/O/V/I) plus the new Ctrl+G inspector.
    const chord = overlayOpen ? undefined : matchAction(keybindings, input, key)
    // Toggle tool/thinking output for the whole transcript. The transcript lives
    // in `<Static>` (write-once), so clear the screen and let the bumped epoch
    // re-print every cell with the new collapsed state.
    if (chord === "collapseAll") {
      clearScreen()
      dispatch({ type: "TOGGLE_COLLAPSE_ALL" })
      return
    }
    // Open incremental find-in-viewport. Fullscreen only: the jump-to-match needs
    // the app-managed scroll viewport (scrollback mode has `/search` instead).
    if (chord === "find") {
      if (fullscreen) cursor.open()
      else dispatch({ type: "NOTICE", message: "Find is available in the fullscreen layout." })
      return
    }
    // Reverse-history-search over the composer history (readline parity). The
    // overlay owns input once open; here we seed it empty with no match yet.
    if (chord === "historySearch") {
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "historySearch",
          query: "",
          match: null,
          matchIndex: state.input.history.entries.length,
        },
      })
      return
    }
    // Persistent detailed-output mode (Claude Code parity): all tool/thinking
    // cells render expanded until toggled off. Same write-once repaint dance.
    if (chord === "verboseToggle") {
      clearScreen()
      dispatch({ type: "TOGGLE_VERBOSE" })
      dispatch({ type: "NOTICE", message: state.verbose ? "Detail mode off" : "Detail mode on" })
      return
    }
    // Open the tool-output inspector: a picker of every tool/bash/subagent cell
    // that produced output; Enter opens its full, highlighted output in the pager.
    if (chord === "inspect") {
      const items = collectInspectables(state.cells)
      if (items.length === 0) {
        dispatch({ type: "NOTICE", message: "No tool output to inspect yet." })
      } else {
        dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "inspect", items, index: 0 } })
      }
      return
    }
    // Open the running-agents panel: in-turn sub-agent dispatches + background
    // runs. Routes through the command pipeline so the runtime dispatcher (which
    // carries the live in-flight tools) builds the rows.
    if (chord === "agentsPanel") {
      // While a foreground `!command` is running, this key backgrounds it
      // (Claude-Code parity) instead of opening the panel; the panel stays
      // reachable via `/agents`.
      if (hasForegroundRun()) {
        backgroundForegroundBash()
        return
      }
      runCommandLine("/agents")
      return
    }
    // Copy the latest assistant reply to the clipboard without entering find
    // mode (Codex Ctrl+O parity). The injected writer handles OSC 52 over SSH.
    if (chord === "copyLast") {
      const reply = lastAssistantText(state)
      if (reply) {
        void Promise.resolve(copyClipboard(reply)).then((res) =>
          dispatch({
            type: "NOTICE",
            message: res.ok ? notices.copiedReply : clipboardFailureMessage(res.reason, notices),
          })
        )
      } else {
        dispatch({ type: "NOTICE", message: notices.noReplyToCopy })
      }
      return
    }
    // Clear the visible scrollback + repaint WITHOUT resetting the conversation
    // (distinct from `/clear`, which wipes the session). Cells are untouched.
    if (chord === "clearScreen") {
      clearScreen()
      scrollReset()
      cursor.clear()
      dispatch({ type: "REPAINT" })
      return
    }
    // Paste an image from the OS clipboard as an `@<path>` mention so it flows
    // through the attachment pipeline.
    if (chord === "pasteImage") {
      void pasteClipboardImage()
      return
    }
    // Inspect the current step of a live `/workflow run` — input/output/logs/usage
    // in a scrollable document overlay (reuses the `document` kind). Only fires
    // when a run is actually in flight.
    if (chord === "workflowInspect" && state.workflowRun?.steps.length) {
      const wr = state.workflowRun
      const sel = wr.currentId
        ? wr.steps.find((s) => s.id === wr.currentId)
        : wr.steps[Math.min(wr.completed, wr.steps.length - 1)]
      if (sel) {
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: `Step · ${sel.label}`,
            body: buildStepInspectorDoc(sel, wr.events ?? []),
            format: "markdown",
          },
        })
      }
      return
    }
    // Shift+Tab cycles the permission mode (Claude Code parity). Persists the
    // choice and re-resolves SendOptions via switchMode so the next turn honours
    // it. Gated on no-overlay so a completion popup's Tab keeps priority.
    if (key.tab && key.shift && !overlayOpen) {
      const next = cyclePermissionMode(state.config.permissionMode)
      persist("permissionMode", next)
      void agent.switchMode(next)
      dispatch({ type: "NOTICE", message: `Permission mode: ${next}` })
      return
    }
    // Esc only acts here when no overlay is open (overlays own their Esc).
    if (key.escape && !overlayOpen) {
      // A live turn / background run: Esc interrupts (existing behaviour) and
      // cancels any half-armed backtrack.
      if (busy || state.activity) {
        if (busy) agent.abort()
        abortRuntime()
        disarmBacktrack()
        return
      }
      // Idle: double-Esc enters backtrack-to-edit selection. Skip while the
      // completion popup is open (its Esc closes the popup) or while the composer
      // holds a draft (don't clobber unsent text). The selection highlights the
      // last user message; ↑/↓ walk earlier/later, Enter loads it for editing.
      if (composerPopupOpen.current) return
      // Esc while editing a backtracked message cancels: drop the edit target and
      // clear the composer (the loaded text is discarded).
      if (state.editTarget) {
        dispatch({ type: "EDIT_CLEAR" })
        dispatch({ type: "INPUT_SET", buffer: bufferFromText("") })
        disarmBacktrack()
        return
      }
      if (bufferText(state.input.buffer).length > 0) {
        disarmBacktrack()
        return
      }
      if (backtrackArmedRef.current) {
        disarmBacktrack()
        // Scrollback: clear so the epoch bump re-prints with the new highlight.
        if (!fullscreen) clearScreen()
        dispatch({ type: "BACKTRACK_ENTER" })
      } else {
        armBacktrack()
      }
    }
  })
}
