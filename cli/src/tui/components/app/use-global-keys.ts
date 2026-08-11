import { useRef } from "react"
import { measureElement, type DOMElement, type Key } from "ink"
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
import {
  LEADER_TIMEOUT_MS,
  resolveChordEvent,
  type KeybindableAction,
} from "../../input/keybindings"
import {
  lastAssistantText,
  lastCodeBlock,
  lastToolResultText,
  lastUserText,
} from "../../state/selectors"
import { formatCellsAsMarkdown } from "../../format/export"
import { resolveClickTarget } from "../../selection/click-target"
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
import { agentTreeRowTarget, type AgentTreeHit } from "../BottomStatus"
import type { resolveKeybindings } from "../../input/keybindings"
import { SELECTION_MODES } from "../../../config/schema"
import { useCriticalInput, useGlobalInput } from "../../input/input-router"
import type {
  MouseMode,
  ResolvedNotices,
  ResolvedRenderConfig,
  SelectionMode,
} from "../../../config/schema"
import type { CopyResult } from "../../clipboard"
import type { SelectionController } from "../../selection/selection-controller"

/**
 * Inputs the global key handler reads off the App. The router's latest-ref seam
 * reads the current values on every keypress, so passing the latest deps is enough.
 */
export interface GlobalKeysDeps {
  state: TuiState
  dispatch: Dispatch<TuiAction>
  overlayOpen: boolean
  busy: boolean
  fullscreen: boolean
  mouseMode: MouseMode
  /** Live in-app selection mode (`/select`). */
  selectionMode: SelectionMode
  /** The selection controller, held by REF rather than by value: the hook that
   * owns it fills the ref in an effect, so a by-value read during render would
   * be null on the first pass (and stale on any pass that follows a remount). */
  selection: { current: SelectionController | null }
  /** Plain rows of the last rendered frame — the surface Ctrl+click resolves
   * its target from. Empty when no frame has been captured. */
  screenRows: () => readonly string[]
  /** Whether a path-shaped token names a real file (resolved against cwd). */
  fileExists: (candidate: string) => boolean
  /** Open a file in the configured editor (routes through the `openFile` effect). */
  openFileAt: (path: string, line?: number, col?: number) => void
  notices: ResolvedNotices
  keybindings: ReturnType<typeof resolveKeybindings>
  renderPrefs: ResolvedRenderConfig
  now: () => number
  doExit: () => void
  /** Abort an in-flight external-backend connect (Esc during `"connecting"`),
   * reclaiming the half-registered agent and routing to the failure page. */
  cancelBackendConnect: () => void
  /** Abort an in-progress external-agent installer (Esc during `installing`). */
  cancelBackendInstall: () => void
  agent: AgentSessionApi
  abortRuntime: () => void
  askUser: AskUserOverlayApi
  hasForegroundRun: () => boolean
  killForegroundBash: () => boolean
  backgroundForegroundBash: () => boolean
  copyClipboard: (text: string) => Promise<CopyResult>
  runCommandLine: (line: string) => void
  openModelPicker: () => void
  pasteClipboardImage: () => Promise<void>
  scrollReset: () => void
  disarmBacktrack: () => void
  armBacktrack: () => void
  cursor: TranscriptCursor
  scroll: ScrollController
  clearScreen: () => void
  composerPopupOpen: MutableRefObject<boolean>
  subagentChipRef: MutableRefObject<DOMElement | null>
  /** Hit-test state the BottomStatus running-agents tree publishes. */
  agentTreeRef: MutableRefObject<AgentTreeHit | null>
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
  // Mirror the armed timestamp synchronously. React may batch two terminal input
  // events before the CTRL_C action re-renders App; consulting state alone then
  // treats both presses as the first one and wrongly requires a third Ctrl+C.
  const lastCtrlCAtRef = useRef<number | null>(deps.state.lastCtrlCAt ?? null)
  // Armed leader-chord prefix (OpenCode-style `"ctrl+x n"` bindings) + when it
  // was armed; lapses after LEADER_TIMEOUT_MS.
  const chordPrefixRef = useRef<{ prefix: string; at: number } | null>(null)
  const escapeInterruptsOverlay =
    deps.state.overlay.kind === "permission" || deps.state.overlay.kind === "askUser"

  const interruptConversation = (): void => {
    if (ctrlCTimer.current) {
      clearTimeout(ctrlCTimer.current)
      ctrlCTimer.current = null
    }
    lastCtrlCAtRef.current = null
    if (deps.state.lastCtrlCAt) deps.dispatch({ type: "CLEAR_CTRL_C" })
    deps.agent.abort()
    deps.abortRuntime()
    if (deps.state.overlay.kind === "permission") deps.dispatch({ type: "OVERLAY_CLOSE" })
    else if (deps.state.overlay.kind === "askUser") {
      deps.askUser.resolve({ selected: [], text: "", cancelled: true })
    }
    deps.disarmBacktrack()
    // A blocked permission/tool call may take time to unwind. Show the boundary
    // immediately; TURN_ABORTED later moves this same marker behind any partial
    // reply instead of appending a duplicate.
    deps.dispatch({
      type: "NOTICE",
      message: "Turn stopped by user.",
      tone: "interrupted",
    })
  }

  useCriticalInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        if (deps.busy) {
          interruptConversation()
          return
        }
        if (
          deps.state.phase === "chat" &&
          !deps.overlayOpen &&
          bufferText(deps.state.input.buffer).length > 0
        ) {
          deps.dispatch({ type: "INPUT_CLEAR" })
          if (ctrlCTimer.current) {
            clearTimeout(ctrlCTimer.current)
            ctrlCTimer.current = null
          }
          lastCtrlCAtRef.current = null
          if (deps.state.lastCtrlCAt) deps.dispatch({ type: "CLEAR_CTRL_C" })
          return
        }
        if (deps.state.phase === "chat" && !deps.overlayOpen && deps.hasForegroundRun()) {
          if (ctrlCTimer.current) {
            clearTimeout(ctrlCTimer.current)
            ctrlCTimer.current = null
          }
          lastCtrlCAtRef.current = null
          if (deps.state.lastCtrlCAt) deps.dispatch({ type: "CLEAR_CTRL_C" })
          deps.killForegroundBash()
          return
        }
        const at = deps.now()
        const previousAt = lastCtrlCAtRef.current
        if (previousAt !== null && at - previousAt < DOUBLE_CTRL_C_MS) {
          if (ctrlCTimer.current) {
            clearTimeout(ctrlCTimer.current)
            ctrlCTimer.current = null
          }
          lastCtrlCAtRef.current = null
          deps.doExit()
        } else {
          lastCtrlCAtRef.current = at
          deps.dispatch({ type: "CTRL_C", at })
          deps.dispatch({ type: "NOTICE", message: "Press Ctrl+C again to exit" })
          if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current)
          ctrlCTimer.current = setTimeout(() => {
            ctrlCTimer.current = null
            lastCtrlCAtRef.current = null
            deps.dispatch({ type: "CLEAR_CTRL_C" })
          }, 3000)
        }
        return
      }
      if (deps.state.phase === "connecting" && key.escape) {
        deps.cancelBackendConnect()
        return
      }
      if (deps.state.phase === "installing" && key.escape) {
        deps.cancelBackendInstall()
        return
      }
      if (key.escape && deps.busy && escapeInterruptsOverlay) interruptConversation()
    },
    {
      shouldHandle: (input, key) =>
        (key.ctrl && input === "c") ||
        (key.escape &&
          (deps.state.phase === "connecting" ||
            deps.state.phase === "installing" ||
            (deps.busy && escapeInterruptsOverlay))),
    }
  )

  const shouldHandleGlobal = (input: string, key: Key): boolean => {
    if (deps.state.phase !== "chat") return true
    if (deps.cursor.state.find || deps.state.backtrack) return true
    if (deps.fullscreen && !deps.overlayOpen) {
      if (
        key.pageUp ||
        key.pageDown ||
        (key.ctrl && (input === "u" || input === "d" || key.upArrow || key.downArrow)) ||
        (bufferText(deps.state.input.buffer).length === 0 && (input === "g" || input === "G")) ||
        parseMouseEvent(input)
      ) {
        return true
      }
    }
    if (!deps.overlayOpen) {
      const pending = chordPrefixRef.current
      const active = pending && deps.now() - pending.at <= LEADER_TIMEOUT_MS ? pending.prefix : null
      if (resolveChordEvent(deps.keybindings, input, key, active).kind !== "none") return true
    }
    return Boolean(
      (key.tab && key.shift && !deps.overlayOpen && !deps.composerPopupOpen.current) ||
      (key.escape && !deps.overlayOpen)
    )
  }

  useGlobalInput(
    (input, key) => {
      const {
        state,
        dispatch,
        overlayOpen,
        busy,
        fullscreen,
        mouseMode,
        selectionMode,
        selection,
        screenRows,
        fileExists,
        openFileAt,
        notices,
        keybindings,
        renderPrefs,
        now,
        abortRuntime,
        hasForegroundRun,
        backgroundForegroundBash,
        copyClipboard,
        runCommandLine,
        openModelPicker,
        pasteClipboardImage,
        scrollReset,
        disarmBacktrack,
        armBacktrack,
        cursor,
        scroll,
        clearScreen,
        composerPopupOpen,
        subagentChipRef,
        agentTreeRef,
        footerRowRef,
        footerSegmentsRef,
        scrollContentRef,
        backtrackArmedRef,
      } = deps

      /** Copy `text`, then report success with `okMessage` or the clipboard's own
       * failure reason. Every copy path in this handler funnels through here so
       * the OSC 52 "too large" / "unavailable" notices stay consistent. */
      const copyWithNotice = (text: string, okMessage: string): void => {
        void Promise.resolve(copyClipboard(text)).then((res) =>
          dispatch({
            type: "NOTICE",
            message: res.ok ? okMessage : clipboardFailureMessage(res.reason, notices),
          })
        )
      }

      /** Copy `text` when it exists, else surface `emptyMessage`. The shape every
       * "copy the last X" chord shares. */
      const copyOrNotice = (
        text: string | null | undefined,
        okMessage: string,
        emptyMessage: string
      ): void => {
        if (text) copyWithNotice(text, okMessage)
        else dispatch({ type: "NOTICE", message: emptyMessage })
      }

      // During the startup gate, only the critical route is honored — the gate owns
      // its own keys.
      if (state.phase === "startup") return
      // While the external backend is coming up, Esc aborts the connect (the one
      // escape hatch from a handshake that hangs, since the composer isn't open);
      // every other key is swallowed so nothing is typed into a backend that may
      // still fail. The failure page owns its own keys via its SelectList, so the
      // global handler must stay out of its way there — otherwise both consume the
      // same keypress.
      if (state.phase === "connecting") {
        return
      }
      if (state.phase === "connect-failed") return
      if (state.phase === "installing") {
        return
      }
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
        if (key.ctrl && input === "u") {
          scroll.halfPageUp()
          return
        }
        if (key.ctrl && input === "d") {
          scroll.halfPageDown()
          return
        }
        if (key.ctrl && key.upArrow) {
          scroll.lineUp()
          return
        }
        if (key.ctrl && key.downArrow) {
          scroll.lineDown()
          return
        }
        if (bufferText(state.input.buffer).length === 0 && input === "g") {
          scroll.toTop()
          return
        }
        if (bufferText(state.input.buffer).length === 0 && input === "G") {
          scroll.toBottom()
          return
        }
        // Mouse reports only arrive in `scroll` mode (SGR tracking is on). Scroll
        // the transcript by a few lines per wheel notch; swallow every other mouse
        // event (clicks/releases) so it never reaches a text field as literal
        // characters. In `select` mode tracking is off, so any stray report is
        // still swallowed here rather than inserted.
        const mouse = parseMouseEvent(input)
        if (mouse) {
          // Ctrl+click is the "smart action at point": open the file path under
          // the pointer, copy the URL under it, or copy the whole clicked row.
          // Checked before the selection so a modified click never starts a drag.
          if (mouse.kind === "click" && mouse.mods.ctrl) {
            const row = screenRows()[mouse.row - 1]
            if (row !== undefined) {
              const target = resolveClickTarget(row, mouse.col - 1, fileExists)
              if (target.kind === "file") openFileAt(target.path, target.line, target.col)
              else if (target.kind === "url") copyWithNotice(target.url, "Copied the link.")
              else if (target.kind === "line") copyWithNotice(target.text, "Copied the line.")
              return
            }
          }
          // A mapped transcript card is an interactive target, so it gets the
          // first chance at a plain press before the selection controller turns
          // that same press into a drag anchor. Empty transcript rows still fall
          // through to normal text selection.
          if (
            mouse.kind === "click" &&
            fullscreen &&
            renderPrefs.clickToExpand &&
            scrollContentRef.current
          ) {
            const contentPos = absoluteTopLeft(scrollContentRef.current)
            if (contentPos) {
              const contentHeight = measureElement(scrollContentRef.current).height || 0
              const contentRow = mouse.row - 1 - contentPos.top
              if (contentRow >= 0 && contentRow < contentHeight) {
                const cellId = cursor.cellIdAtContentRow(contentRow)
                if (cellId) {
                  dispatch({ type: "TOGGLE_COLLAPSE", id: cellId })
                  return
                }
              }
            }
          }
          // In-app text selection owns drags (and the repeat press of a double /
          // triple click). It deliberately declines a first plain press, so every
          // single-click behaviour below is untouched.
          if (selection.current?.handleMouse(mouse)) return
          // While the composer popup owns input, let it consume the wheel (it
          // scrolls the popup) instead of paging the transcript underneath.
          if (mouse.kind === "wheel" && mouseMode === "scroll" && !composerPopupOpen.current) {
            for (let i = 0; i < WHEEL_SCROLL_LINES; i++) {
              if (mouse.dir === "up") scroll.lineUp()
              else scroll.lineDown()
            }
          } else if (mouse.kind === "click") {
            // A click inside the running-agents tree: an agent row opens that
            // agent's live run page directly; the header / overflow line falls
            // back to the `/agents` panel.
            const tree = agentTreeRef.current
            if (tree?.box) {
              const pos = absoluteTopLeft(tree.box)
              if (pos) {
                const height = measureElement(tree.box).height || 0
                const offset = mouse.row - 1 - pos.top
                if (offset >= 0 && offset < height) {
                  const target = agentTreeRowTarget(offset, tree.agents.length)
                  const picked = typeof target === "number" ? tree.agents[target] : undefined
                  if (picked) {
                    dispatch({
                      type: "OVERLAY_OPEN",
                      overlay: {
                        kind: "agentRun",
                        liveId: picked.liveId,
                        name: picked.name,
                        task: picked.task,
                      },
                    })
                  } else if (target !== null) {
                    runCommandLine("/agents")
                  }
                  return
                }
              }
            }
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
                  runCommandLine(`/mode ${cyclePermissionMode(state.config.permissionMode)}`)
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
      let chord: KeybindableAction | undefined
      if (!overlayOpen) {
        // Chord-aware resolution: single chords match directly; a leader binding
        // (`"ctrl+x n"`) arms its prefix on the first key and completes (or
        // lapses after LEADER_TIMEOUT_MS / on a non-matching key) on the next.
        const pending = chordPrefixRef.current
        chordPrefixRef.current = null
        const active = pending && now() - pending.at <= LEADER_TIMEOUT_MS ? pending.prefix : null
        const res = resolveChordEvent(keybindings, input, key, active)
        if (res.kind === "action") {
          chord = res.action
        } else if (res.kind === "prefix") {
          chordPrefixRef.current = { prefix: res.prefix, at: now() }
          return // leader consumed; the next key completes or drops the chord
        }
      }
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
        copyOrNotice(lastAssistantText(state), notices.copiedReply, notices.noReplyToCopy)
        return
      }
      // The rest of the copy family — the same "grab the last X" shape, each on a
      // rebindable chord so the common targets need no `/copy` round-trip.
      if (chord === "copyLastUser") {
        copyOrNotice(lastUserText(state), notices.copiedUserMessage, notices.noUserMessageToCopy)
        return
      }
      if (chord === "copyCodeBlock") {
        copyOrNotice(lastCodeBlock(state), notices.copiedCodeBlock, notices.noCodeBlockToCopy)
        return
      }
      if (chord === "copyToolOutput") {
        copyOrNotice(
          lastToolResultText(state),
          notices.copiedToolOutput,
          notices.noToolResultToCopy
        )
        return
      }
      // The whole conversation as markdown — every cell on screen, not just the
      // persisted user/assistant turns (see `formatCellsAsMarkdown`).
      if (chord === "copyTranscript") {
        const doc = formatCellsAsMarkdown(state.cells)
        copyOrNotice(doc, `Copied the conversation (${doc.length} chars).`, "Nothing to copy yet.")
        return
      }
      // Copy whatever is currently highlighted. Only meaningful with `/select`
      // on; the notice says so rather than failing silently.
      if (chord === "copySelection") {
        if (!selection.current?.copySelection()) {
          dispatch({ type: "NOTICE", message: notices.noSelectionToCopy })
        }
        return
      }
      // One-key swap of the mouse model, routed through `/mouse` so persistence
      // and the live escape re-issue stay in one place.
      if (chord === "mouseToggle") {
        runCommandLine(`/mouse ${mouseMode === "scroll" ? "select" : "scroll"}`)
        return
      }
      // Cycle off → manual → auto-copy → off, likewise through `/select`.
      if (chord === "selectionCycle") {
        const next =
          SELECTION_MODES[(SELECTION_MODES.indexOf(selectionMode) + 1) % SELECTION_MODES.length]
        runCommandLine(`/select ${next}`)
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
      // Shift+Tab cycles the permission mode (Claude Code parity). Routed through
      // the command path so the persist / switchMode / notice — and the danger-tier
      // acknowledgement that now guards `bypassPermissions` at the end of the
      // cycle — have exactly ONE implementation. Gated on no-overlay so a
      // completion popup's Tab keeps priority; that same gate is what stops a
      // key-repeat from blowing past the acknowledgement confirm once it opens.
      if (key.tab && key.shift && !overlayOpen && !composerPopupOpen.current) {
        runCommandLine(`/mode ${cyclePermissionMode(state.config.permissionMode)}`)
        return
      }
      // Esc only acts here when no overlay is open (overlays own their Esc).
      if (key.escape && !overlayOpen) {
        // A painted selection is the most local thing Esc can undo, so it goes
        // first — and only when there IS one, so Esc keeps interrupting / arming
        // backtrack exactly as before whenever nothing is selected.
        if (selection.current?.clear()) return
        // A live turn / background run: Esc interrupts (existing behaviour) and
        // cancels any half-armed backtrack.
        if (busy || state.activity) {
          if (busy) interruptConversation()
          else {
            abortRuntime()
            disarmBacktrack()
          }
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
    },
    { shouldHandle: shouldHandleGlobal }
  )
}
