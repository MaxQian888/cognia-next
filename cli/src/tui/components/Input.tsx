/**
 * The composer: a multiline editor with command history, a `/` command palette,
 * `@` file-path completion, and large-paste collapsing. All editing/keymap logic
 * is pure (`input/*`, `commands/*`); this component wires those to Ink's
 * `useInput` and the reducer's input state, and renders the buffer + popups.
 *
 * Global keys (Ctrl+C exit, Esc-while-busy interrupt) are owned by the App; this
 * handler treats `exit`/`interrupt` intents as no-ops.
 */
import fs from "node:fs"
import path from "node:path"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useInput, useStdin } from "ink"

import { SlashPalette } from "./SlashPalette"
import { MentionPalette, orderByGroup } from "./MentionPalette"
import { useTheme } from "../theme/context"
import { moveIndex } from "./select-list-state"
import {
  backspace,
  bufferFromText,
  bufferText,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordLeft,
  insertNewline,
  insertText,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  moveWordLeft,
  moveWordRight,
  onFirstLine,
  onLastLine,
} from "../input/buffer"
import { historyDown, historyUp } from "../input/history"
import { interpretKey } from "../input/keymap"
import {
  collapsePaste,
  expandPastes,
  PASTE_CHAR_THRESHOLD,
  type PasteResult,
} from "../input/paste-collapse"
import { createPasteParser } from "../input/bracketed-paste"
import { matchSlash, slashQuery } from "../commands/matcher"
import { buildCommandHint } from "../commands/command-hint"
import { type ListDir } from "../commands/file-completer"
import { detectMention } from "../mention/detector"
import { acceptMention } from "../mention/accept"
import { highlightMentions } from "../mention/highlight"
import { createMentionProviders, type MentionProviders } from "../mention/providers"
import { createMentionLoader } from "../mention/async-load"
import type { MentionCandidate } from "../mention/types"
import type { InputBuffer, InputState, TuiAction } from "../state/types"

const PASTE_THRESHOLD = 4

/**
 * Decide whether an inserted chunk should collapse to a `[Pasted …]` placeholder.
 * A chunk collapses when it crosses EITHER the line-count threshold (the original
 * heuristic for terminals without bracketed paste) OR the character threshold (so
 * a single very long line pasted atomically via bracketed paste still collapses).
 * Pure so the routing is unit-testable without rendering Ink.
 */
export function routePasteInsert(
  chunk: string,
  id: number,
  lineThreshold = PASTE_THRESHOLD,
  charThreshold = PASTE_CHAR_THRESHOLD
): PasteResult {
  return collapsePaste(chunk, id, lineThreshold, charThreshold)
}

function makeFsListDir(cwd: string): ListDir {
  return (dir) => {
    try {
      return fs
        .readdirSync(path.resolve(cwd, dir), { withFileTypes: true })
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
    } catch {
      return []
    }
  }
}

/** Render a line's mention tokens in their kind colour (cosmetic only). Used
 * when the cursor is not on this row, so we never have to splice the inverse
 * cursor cell into a coloured segment. */
function HighlightedLine({ line }: { line: string }) {
  const theme = useTheme()
  const segments = highlightMentions(line)
  return (
    <Text>
      {segments.map((seg, i) => {
        const color =
          seg.kind === "skill" ? theme.accent : seg.kind === "agent" ? theme.info : undefined
        return (
          <Text key={i} color={color}>
            {seg.text}
          </Text>
        )
      })}
    </Text>
  )
}

function LineView({
  line,
  cursorCol,
  disabled,
}: {
  line: string
  cursorCol: number
  disabled: boolean
}) {
  // No cursor on this row → render with mention-token highlighting.
  if (cursorCol < 0 || disabled) return <HighlightedLine line={line} />
  const before = line.slice(0, cursorCol)
  const at = line.slice(cursorCol, cursorCol + 1) || " "
  const after = line.slice(cursorCol + 1)
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  )
}

export function Input({
  input,
  dispatch,
  onSubmit,
  onHistoryPush,
  disabled = false,
  cwd,
  listDir: listDirProp,
  mentionProviders: mentionProvidersProp,
  width,
  popupRows,
  keybindings,
}: {
  input: InputState
  dispatch: (action: TuiAction) => void
  onSubmit: (text: string) => void
  /** Persist a submitted line to durable history (in addition to the in-memory
   * ring the reducer keeps). Optional — tests omit it. */
  onHistoryPush?: (entry: string) => void
  disabled?: boolean
  cwd: string
  listDir?: ListDir
  /** Skill/agent/file candidate sources for the `@` popup. Defaults to the real
   * disk/db providers; tests inject a stub. */
  mentionProviders?: MentionProviders
  /** Terminal columns so the composer + popups span the full width. */
  width?: number | string
  /** Row budget for the `@`/`/` popups so they stay compact above the composer. */
  popupRows?: number
  /** Resolved editor key bindings (line-home/end, word-delete). Optional — the
   * defaults are used when omitted. */
  keybindings?: Record<string, string>
}) {
  const theme = useTheme()
  const buffer = input.buffer
  const text = bufferText(buffer)
  const listDir = useMemo(() => listDirProp ?? makeFsListDir(cwd), [listDirProp, cwd])
  const mentionProviders = useMemo(
    () => mentionProvidersProp ?? createMentionProviders({ cwd, home: cwd, roots: [cwd] }),
    [mentionProvidersProp, cwd]
  )

  const [popupIndex, setPopupIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  // Async skill/agent candidates for the current `@` token, loaded in an effect.
  const [asyncCandidates, setAsyncCandidates] = useState<MentionCandidate[]>([])
  const [asyncLoading, setAsyncLoading] = useState(false)
  const pasteSeq = useRef(0)

  // Derive the active popup from the buffer.
  const sQuery = slashQuery(text)
  const slashMatches = sQuery !== null ? matchSlash(sQuery, { history: input.history.entries }) : []
  const beforeCursor = buffer.lines[buffer.cursorRow].slice(0, buffer.cursorCol)
  const detected = sQuery === null ? detectMention(beforeCursor) : null

  // Files compute synchronously; skills/agents arrive via the effect below.
  const fileCandidates =
    detected && (detected.mode === "file" || detected.mode === "mixed")
      ? mentionProviders.files(detected.query, listDir)
      : []
  const mentionCandidates = orderByGroup([...fileCandidates, ...asyncCandidates])

  // Load skill/agent candidates whenever the `@` token (mode+query) changes.
  // The result lands via a promise (never a synchronous setState in the effect
  // body). When no skill/agent token is active the effect short-circuits: the
  // popup gates on `detected`, so any stale list is already hidden and need not
  // be cleared, and plain typing schedules no provider work.
  const wantSkills = detected?.mode === "mixed" || detected?.mode === "skill"
  const wantAgents = detected?.mode === "mixed" || detected?.mode === "agent"
  const mentionKey =
    detected && (wantSkills || wantAgents) ? `${detected.mode}:${detected.query}` : null

  // Debounced + stale-guarded loader over the providers. Memoised so its identity
  // is stable across keystrokes (only re-created if the providers change), and it
  // captures `mentionProviders` by value — no ref read during render.
  const mentionLoader = useMemo(
    () =>
      createMentionLoader(async (key: string) => {
        const sep = key.indexOf(":")
        const mode = key.slice(0, sep)
        const query = key.slice(sep + 1)
        const [skills, agents] = await Promise.all([
          mode === "mixed" || mode === "skill"
            ? mentionProviders.skills(query)
            : Promise.resolve([]),
          mode === "mixed" || mode === "agent"
            ? mentionProviders.agents(query)
            : Promise.resolve([]),
        ])
        return [...skills, ...agents]
      }),
    [mentionProviders]
  )

  // Kick off a (debounced) load whenever the `@` token changes. State updates only
  // happen inside the loader callback (loading flips true immediately, then the
  // candidates land), so the effect body itself calls no setState synchronously.
  // A stale `asyncLoading` when no token is active is masked by `mentionLoading`
  // below (gated on `mentionKey`), so the null branch needs no reset.
  useEffect(() => {
    if (mentionKey === null) {
      mentionLoader.cancel()
      return
    }
    mentionLoader.request(mentionKey, ({ loading, candidates }) => {
      setAsyncLoading(loading)
      if (loading) setAsyncCandidates([])
      else setAsyncCandidates(candidates)
    })
    return () => mentionLoader.cancel()
  }, [mentionKey, mentionLoader])

  // Loading only counts while a skill/agent token is actually active.
  const mentionLoading = mentionKey !== null && asyncLoading

  // The mention popup is shown only while an `@` token is under the cursor —
  // gating on `detected` (not just the candidate list) so a stale async result
  // can't keep the popup open after the token is accepted/cleared.
  const popupKind: "slash" | "mention" | "none" =
    slashMatches.length > 0
      ? "slash"
      : detected && (mentionCandidates.length > 0 || mentionLoading)
        ? "mention"
        : "none"
  const popupOpen = popupKind !== "none" && dismissed !== text
  // Inline usage hint for a partially-typed command (e.g. `/goal <objective …>`),
  // shown below the composer once a space follows a known command. Suppressed
  // while a popup is open so the two affordances never overlap.
  const commandHint = popupOpen || disabled ? null : buildCommandHint(text)
  const popupLen = popupKind === "slash" ? slashMatches.length : mentionCandidates.length
  const safeIndex = popupLen > 0 ? popupIndex % popupLen : 0

  const setBuffer = (next: InputBuffer) => {
    setDismissed(null)
    dispatch({ type: "INPUT_SET", buffer: next })
  }

  const doSubmit = () => {
    const raw = bufferText(buffer)
    if (raw.trim().length === 0) return
    const expanded = expandPastes(raw, input.pastes).trim()
    dispatch({ type: "INPUT_PUSH_HISTORY", entry: raw })
    onHistoryPush?.(raw)
    onSubmit(expanded)
  }

  const acceptPopup = () => {
    if (popupKind === "slash") {
      const cmd = slashMatches[safeIndex]
      const line = `/${cmd.name}`
      dispatch({ type: "INPUT_PUSH_HISTORY", entry: line })
      onHistoryPush?.(line)
      dispatch({ type: "INPUT_CLEAR" })
      onSubmit(line)
      return
    }
    if (popupKind === "mention" && detected) {
      const candidate = mentionCandidates[safeIndex]
      if (candidate) setBuffer(acceptMention(buffer, detected, candidate))
    }
  }

  // Tab on an open popup: complete the token in place without submitting. For
  // the slash palette this inserts `/<name> ` so the user can keep typing args
  // (Enter still submits). For mentions there's no submit/complete distinction,
  // so it behaves like accept.
  const completePopup = () => {
    if (popupKind === "slash") {
      const cmd = slashMatches[safeIndex]
      if (cmd) setBuffer(bufferFromText(`/${cmd.name} `))
      return
    }
    if (popupKind === "mention" && detected) {
      const candidate = mentionCandidates[safeIndex]
      if (candidate) setBuffer(acceptMention(buffer, detected, candidate))
    }
  }

  const applyInsert = (chunk: string) => {
    const r = routePasteInsert(chunk, pasteSeq.current)
    if (r.isLarge) {
      pasteSeq.current++
      dispatch({ type: "INPUT_ADD_PASTE", id: r.display, text: r.stored })
      setBuffer(insertText(buffer, r.display))
    } else {
      setBuffer(insertText(buffer, chunk))
    }
  }

  // Keep the latest `applyInsert` reachable from the raw-stdin listener below
  // without re-subscribing on every keystroke (the effect captures a stable ref).
  const applyInsertRef = useRef(applyInsert)
  useEffect(() => {
    applyInsertRef.current = applyInsert
  })

  // Bracketed-paste route. Terminals with bracketed paste enabled (mount.tsx
  // writes `ESC[?2004h`) wrap a paste in `ESC[200~ … ESC[201~`. Ink's `useInput`
  // would surface that body char-by-char; instead we tee the raw stdin through a
  // `createPasteParser`, and when a full paste span completes we insert it as one
  // atomic chunk — so a huge single-line paste collapses via the char threshold.
  // The `keys` portion is left untouched; Ink's own `useInput` still handles it.
  const { stdin, setRawMode, isRawModeSupported } = useStdin()
  useEffect(() => {
    if (disabled || !stdin) return
    if (isRawModeSupported) setRawMode?.(true)
    const parser = createPasteParser()
    const onData = (data: Buffer | string) => {
      const { pastes } = parser.feed(typeof data === "string" ? data : data.toString("utf8"))
      for (const body of pastes) applyInsertRef.current(body)
    }
    stdin.on("data", onData)
    return () => {
      stdin.off?.("data", onData)
    }
  }, [stdin, disabled, isRawModeSupported, setRawMode])

  useInput(
    (inputCh, key) => {
      const intent = interpretKey(
        inputCh,
        key,
        {
          popupOpen,
          onFirstLine: onFirstLine(buffer),
          onLastLine: onLastLine(buffer),
        },
        keybindings
      )
      switch (intent.type) {
        case "insert":
          applyInsert(intent.text)
          break
        case "newline":
          setBuffer(insertNewline(buffer))
          break
        case "backspace":
          setBuffer(backspace(buffer))
          break
        case "delete-word":
          setBuffer(deleteWordLeft(buffer))
          break
        case "kill-to-start":
          setBuffer(deleteToLineStart(buffer))
          break
        case "kill-to-end":
          setBuffer(deleteToLineEnd(buffer))
          break
        case "undo":
          // Undo/redo are reducer-owned (the undo stack lives in input state), so
          // dispatch directly rather than routing through setBuffer.
          setDismissed(null)
          dispatch({ type: "INPUT_UNDO" })
          break
        case "redo":
          setDismissed(null)
          dispatch({ type: "INPUT_REDO" })
          break
        case "move":
          setBuffer(
            {
              left: moveLeft,
              right: moveRight,
              up: moveUp,
              down: moveDown,
              home: moveHome,
              end: moveEnd,
              "word-left": moveWordLeft,
              "word-right": moveWordRight,
            }[intent.dir](buffer)
          )
          break
        case "history": {
          const r =
            intent.dir === "up" ? historyUp(input.history, text) : historyDown(input.history)
          dispatch({ type: "INPUT_HISTORY", history: r.history })
          dispatch({ type: "INPUT_SET", buffer: bufferFromText(r.text) })
          break
        }
        case "submit":
          doSubmit()
          break
        case "popup-move":
          setPopupIndex(moveIndex(safeIndex, intent.delta, popupLen))
          break
        case "popup-accept":
          acceptPopup()
          break
        case "popup-complete":
          completePopup()
          break
        case "popup-cancel":
          setDismissed(text)
          break
        default:
          break
      }
    },
    { isActive: !disabled }
  )

  return (
    <Box flexDirection="column" width={width}>
      {popupOpen && popupKind === "slash" && (
        <SlashPalette matches={slashMatches} index={safeIndex} maxRows={popupRows} width={width} />
      )}
      {popupOpen && popupKind === "mention" && (
        <MentionPalette
          candidates={mentionCandidates}
          index={safeIndex}
          maxRows={popupRows}
          width={width}
          loading={mentionLoading}
        />
      )}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={disabled ? theme.borderSubtle : theme.border}
        paddingX={1}
        width={width}
      >
        {buffer.lines.map((line, row) => (
          <Box key={row}>
            <Text color={disabled ? theme.muted : theme.userPrompt}>{row === 0 ? "› " : "  "}</Text>
            <LineView
              line={line}
              cursorCol={row === buffer.cursorRow ? buffer.cursorCol : -1}
              disabled={disabled}
            />
          </Box>
        ))}
      </Box>
      {commandHint ? (
        <Text color={theme.muted} dimColor>
          {"  "}
          {commandHint}
        </Text>
      ) : null}
    </Box>
  )
}
