/**
 * The `ask_user` elicitation overlay — the CLI counterpart of the desktop's
 * `components/chat/ask-user-dialog.tsx`. The agent calls the `ask_user` tool to
 * pause and ask the user a structured question; that call round-trips through
 * the plugin-tool wire into `useAskUserStore`, the App opens this overlay, and
 * the user's submission resolves the tool call so the turn continues. Without
 * this overlay the tool call blocks forever (the historical hang).
 *
 * Self-contained, like the MCP/skill panels: it owns its keyboard handling and
 * local draft state (selection + free text + a row cursor) via `useInput`, and
 * calls `onResolve` exactly once on submit (Enter) or cancel (Esc). The
 * navigation/answer logic is factored into the pure helpers below so it unit-
 * tests without Ink.
 */
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../../theme/context"
import { isMouseSequence } from "../../input/mouse"
import { OverlayFooter } from "../OverlayFooter"
import type { AskUserAnswer, AskUserRequest } from "@/lib/claude/ask-user-tool"

/** The dialog's local draft: which options are checked, the free-text answer,
 * and which row the cursor is on (options first, then the text row when
 * `allowText`). */
export interface AskUserDraft {
  selected: string[]
  text: string
  cursor: number
}

/** Number of focusable rows: one per option, plus a free-text row when allowed. */
export function askUserRowCount(req: AskUserRequest): number {
  return req.options.length + (req.allowText ? 1 : 0)
}

/** Whether the cursor sits on the free-text row (the row after the options). */
export function isTextRow(req: AskUserRequest, cursor: number): boolean {
  return req.allowText && cursor === req.options.length
}

/** Whether the current draft is answerable — a selection, or (when free text is
 * allowed) some non-blank text. Mirrors the desktop `canSubmit` guard so Enter
 * on an empty prompt is a no-op rather than an empty answer. */
export function canSubmitAsk(req: AskUserRequest, draft: AskUserDraft): boolean {
  if (draft.selected.length > 0) return true
  if (req.allowText) return draft.text.trim().length > 0
  return false
}

/** Toggle one option in the draft. Multi-select toggles membership; single-
 * select replaces the selection (and clears it when re-picking the same value). */
export function toggleOption(
  req: AskUserRequest,
  draft: AskUserDraft,
  value: string
): AskUserDraft {
  if (req.multiSelect) {
    const selected = draft.selected.includes(value)
      ? draft.selected.filter((v) => v !== value)
      : [...draft.selected, value]
    return { ...draft, selected }
  }
  const selected = draft.selected[0] === value ? [] : [value]
  return { ...draft, selected }
}

/** Move the row cursor, clamped to `[0, rowCount)`. */
export function moveCursor(req: AskUserRequest, draft: AskUserDraft, delta: number): AskUserDraft {
  const rows = askUserRowCount(req)
  if (rows <= 1) return draft
  const cursor = Math.max(0, Math.min(rows - 1, draft.cursor + delta))
  return { ...draft, cursor }
}

/** The answer the model receives on submit. */
export function buildAnswer(draft: AskUserDraft): AskUserAnswer {
  return { selected: draft.selected, text: draft.text, cancelled: false }
}

export function AskUserDialog({
  request,
  onResolve,
}: {
  request: AskUserRequest
  onResolve: (answer: AskUserAnswer) => void
}) {
  const theme = useTheme()
  const [draft, setDraft] = useState<AskUserDraft>({ selected: [], text: "", cursor: 0 })

  const submit = () => {
    if (canSubmitAsk(request, draft)) onResolve(buildAnswer(draft))
  }
  const cancel = () => onResolve({ selected: [], text: "", cancelled: true })

  useInput((input, key) => {
    if (key.escape) {
      cancel()
      return
    }
    if (key.return) {
      // Convenience: pressing Enter on a focused single-select option with
      // nothing chosen yet selects it, so a plain choice prompt needs only
      // arrows + Enter.
      const onOption = !isTextRow(request, draft.cursor) && draft.cursor < request.options.length
      if (onOption && !request.multiSelect && draft.selected.length === 0) {
        const picked = toggleOption(request, draft, request.options[draft.cursor].value)
        if (canSubmitAsk(request, picked)) onResolve(buildAnswer(picked))
        return
      }
      submit()
      return
    }
    if (key.upArrow) {
      setDraft((d) => moveCursor(request, d, -1))
      return
    }
    if (key.downArrow) {
      setDraft((d) => moveCursor(request, d, 1))
      return
    }
    const onText = isTextRow(request, draft.cursor)
    if (onText) {
      // The free-text row captures printable input + backspace.
      if (key.backspace || key.delete) {
        setDraft((d) => ({ ...d, text: d.text.slice(0, -1) }))
        return
      }
      if (input && !key.ctrl && !key.meta && !isMouseSequence(input)) {
        setDraft((d) => ({ ...d, text: d.text + input }))
      }
      return
    }
    // On an option row, Space toggles the focused choice.
    if (input === " " && draft.cursor < request.options.length) {
      setDraft((d) => toggleOption(request, d, request.options[d.cursor].value))
    }
  })

  const hint = request.multiSelect
    ? "↑/↓ move · Space toggle · Enter submit · Esc cancel"
    : request.allowText && request.options.length === 0
      ? "type your answer · Enter submit · Esc cancel"
      : "↑/↓ move · Space/Enter select · Enter submit · Esc cancel"

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.accent} bold>
        {request.question}
      </Text>
      {request.multiSelect ? (
        <Text color={theme.muted} dimColor>
          Select one or more
        </Text>
      ) : null}
      {request.options.map((o, i) => {
        const focused = !isTextRow(request, draft.cursor) && draft.cursor === i
        const checked = draft.selected.includes(o.value)
        const mark = request.multiSelect ? (checked ? "[x]" : "[ ]") : checked ? "(•)" : "( )"
        return (
          <Text key={o.value} color={focused ? theme.accent : undefined} bold={focused}>
            {focused ? "❯ " : "  "}
            {mark} {o.label}
          </Text>
        )
      })}
      {request.allowText ? (
        <Box marginTop={request.options.length > 0 ? 1 : 0}>
          <Text color={isTextRow(request, draft.cursor) ? theme.accent : theme.muted}>
            {isTextRow(request, draft.cursor) ? "❯ " : "  "}
          </Text>
          <Text>
            {draft.text}
            {isTextRow(request, draft.cursor) ? <Text color={theme.accent}>▏</Text> : null}
            {!draft.text && !isTextRow(request, draft.cursor) ? (
              <Text color={theme.muted} dimColor>
                (free text)
              </Text>
            ) : null}
          </Text>
        </Box>
      ) : null}
      <OverlayFooter hint={hint} />
    </Box>
  )
}
