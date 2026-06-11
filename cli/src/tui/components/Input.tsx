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
import React, { useMemo, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"

import { FileCompleter } from "./FileCompleter"
import { SlashPalette } from "./SlashPalette"
import { moveIndex } from "./select-list-state"
import {
  backspace,
  bufferFromText,
  bufferText,
  deleteWordLeft,
  insertNewline,
  insertText,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  onFirstLine,
  onLastLine,
} from "../input/buffer"
import { historyDown, historyUp } from "../input/history"
import { interpretKey } from "../input/keymap"
import { collapsePaste, expandPastes } from "../input/paste-collapse"
import { matchSlash, slashQuery } from "../commands/matcher"
import { activeAtToken, completeAtPath, type ListDir } from "../commands/file-completer"
import type { InputBuffer, InputState, TuiAction } from "../state/types"

const PASTE_THRESHOLD = 4

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

function LineView({
  line,
  cursorCol,
  disabled,
}: {
  line: string
  cursorCol: number
  disabled: boolean
}) {
  if (cursorCol < 0 || disabled) return <Text>{line}</Text>
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
  disabled = false,
  cwd,
  listDir: listDirProp,
}: {
  input: InputState
  dispatch: (action: TuiAction) => void
  onSubmit: (text: string) => void
  disabled?: boolean
  cwd: string
  listDir?: ListDir
}) {
  const buffer = input.buffer
  const text = bufferText(buffer)
  const listDir = useMemo(() => listDirProp ?? makeFsListDir(cwd), [listDirProp, cwd])

  const [popupIndex, setPopupIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const pasteSeq = useRef(0)

  // Derive the active popup from the buffer.
  const sQuery = slashQuery(text)
  const slashMatches = sQuery !== null ? matchSlash(sQuery) : []
  const beforeCursor = buffer.lines[buffer.cursorRow].slice(0, buffer.cursorCol)
  const at = activeAtToken(beforeCursor)
  const fileCompletions = at ? completeAtPath(at.token, listDir) : []
  const popupKind: "slash" | "files" | "none" =
    slashMatches.length > 0 ? "slash" : fileCompletions.length > 0 ? "files" : "none"
  const popupOpen = popupKind !== "none" && dismissed !== text
  const popupLen = popupKind === "slash" ? slashMatches.length : fileCompletions.length
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
    onSubmit(expanded)
  }

  const acceptPopup = () => {
    if (popupKind === "slash") {
      const cmd = slashMatches[safeIndex]
      dispatch({ type: "INPUT_CLEAR" })
      onSubmit(`/${cmd.name}`)
      return
    }
    if (popupKind === "files" && at) {
      const completion = fileCompletions[safeIndex]
      const line = buffer.lines[buffer.cursorRow]
      const newLine = line.slice(0, at.start) + completion + " " + line.slice(buffer.cursorCol)
      const lines = [...buffer.lines]
      lines[buffer.cursorRow] = newLine
      setBuffer({ lines, cursorRow: buffer.cursorRow, cursorCol: at.start + completion.length + 1 })
    }
  }

  const applyInsert = (chunk: string) => {
    if (chunk.split("\n").length > PASTE_THRESHOLD) {
      const id = pasteSeq.current++
      const r = collapsePaste(chunk, id, PASTE_THRESHOLD)
      dispatch({ type: "INPUT_ADD_PASTE", id: r.display, text: r.stored })
      setBuffer(insertText(buffer, r.display))
    } else {
      setBuffer(insertText(buffer, chunk))
    }
  }

  useInput(
    (inputCh, key) => {
      const intent = interpretKey(inputCh, key, {
        popupOpen,
        onFirstLine: onFirstLine(buffer),
        onLastLine: onLastLine(buffer),
      })
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
        case "move":
          setBuffer(
            {
              left: moveLeft,
              right: moveRight,
              up: moveUp,
              down: moveDown,
              home: moveHome,
              end: moveEnd,
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
    <Box flexDirection="column">
      {popupOpen && popupKind === "slash" && (
        <SlashPalette matches={slashMatches} index={safeIndex} />
      )}
      {popupOpen && popupKind === "files" && (
        <FileCompleter completions={fileCompletions} index={safeIndex} />
      )}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={disabled ? "gray" : "cyan"}
        paddingX={1}
      >
        {buffer.lines.map((line, row) => (
          <Box key={row}>
            <Text color={disabled ? "gray" : "green"}>{row === 0 ? "› " : "  "}</Text>
            <LineView
              line={line}
              cursorCol={row === buffer.cursorRow ? buffer.cursorCol : -1}
              disabled={disabled}
            />
          </Box>
        ))}
      </Box>
    </Box>
  )
}
