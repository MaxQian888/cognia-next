/**
 * The `/images` panel (attachments keybinding): manage the composer's pasted
 * image attachments — one row per live `[Image N]` placeholder plus its
 * resolved file path and a "missing" badge when the file is gone.
 *
 * Rows are derived live from the draft by the caller, so a removal (or a new
 * paste) re-renders an open panel without a refresh action. Selection/highlight
 * live here; the parent owns the rows and the remove/open callbacks.
 *
 * Keys: ↑/↓ move · d / ⌫ remove · c clear all · Enter open · Esc close.
 * A click opens the image in the system viewer (composer parity).
 */
import React, { useRef, useState } from "react"
import { Box, Text, type DOMElement } from "ink"
import { useModalInput } from "../../input/input-router"

import { useTheme } from "../../theme/context"
import { isMouseSequence } from "../../input/mouse"
import { usePanelClick } from "../../input/use-panel-click"
import { windowList } from "../list-window"
import { OverlayFooter } from "../OverlayFooter"
import { useCliTranslations } from "../../i18n"

/** One attachment row: the placeholder label plus its resolved file path. */
export interface AttachmentRow {
  /** `[Image N]` placeholder label (also the paste-map key). */
  label: string
  /** Resolved image path. */
  path: string
  /** False when the file has been moved/deleted since it was pasted. */
  exists: boolean
}

const DEFAULT_MAX_ROWS = 10

export function AttachmentsPanel({
  rows,
  onRemove,
  onOpen,
  onCancel,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: {
  rows: AttachmentRow[]
  /** Remove the given labels from the draft (undoable). */
  onRemove: (labels: string[]) => void
  /** Open an image in the system viewer (Enter / click). */
  onOpen: (path: string) => void
  onCancel: () => void
  isActive?: boolean
  maxRows?: number
  width?: number | string
}) {
  const theme = useTheme()
  const t = useCliTranslations("cliUiCommands")
  const tc = useCliTranslations("cliUiCommon")
  const [index, setIndex] = useState(0)
  const boxRef = useRef<DOMElement | null>(null)

  const safeIndex = rows.length > 0 ? Math.min(index, rows.length - 1) : 0
  const current = rows[safeIndex]

  const win = windowList(rows.length, safeIndex, maxRows)
  const visible = rows.slice(win.start, win.end)

  // Mouse (fullscreen `scroll` only): header = title (1 row); a click opens the
  // image in the system viewer — the same thing Enter does.
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: 1,
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    onPick: (offset) => {
      const target = rows[win.start + offset]
      if (target) {
        setIndex(win.start + offset)
        onOpen(target.path)
      }
    },
    onWheel: (dir) =>
      setIndex((i) =>
        dir === "up"
          ? Math.max(0, Math.min(i, rows.length - 1) - 1)
          : Math.min(rows.length - 1, i + 1)
      ),
  })

  useModalInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (key.escape) return onCancel()
      if (key.upArrow) {
        setIndex((i) => Math.max(0, Math.min(i, rows.length - 1) - 1))
        return
      }
      if (key.downArrow) {
        setIndex((i) => Math.min(rows.length - 1, i + 1))
        return
      }
      if (key.return) {
        if (current) onOpen(current.path)
        return
      }
      // `d`, ⌫ and forward-delete all remove the highlighted attachment — the
      // label is atomic, so one keystroke drops the whole `[Image N]`.
      if (input === "d" || input === "D" || key.backspace || key.delete) {
        if (current) onRemove([current.label])
        return
      }
      if (input === "c" || input === "C") {
        if (rows.length > 0) onRemove(rows.map((r) => r.label))
        return
      }
      if (input && isMouseSequence(input)) return
      // Everything else is swallowed: the panel has no filter box, and stray
      // keys must not leak into the composer behind it.
    },
    { isActive }
  )

  return (
    <Box
      ref={boxRef}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text bold>
        {t("imagesTitle")}
        <Text color={theme.muted}>
          {"  "}
          {rows.length}
        </Text>
      </Text>
      {rows.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}
          {t("imagesEmpty")}
        </Text>
      ) : (
        <>
          {win.above > 0 ? (
            <Text color={theme.muted} dimColor>
              {"  "}
              {tc("moreAbove", { count: win.above })}
            </Text>
          ) : null}
          {visible.map((r, i) => {
            const row = win.start + i
            const selected = row === safeIndex
            return (
              <Text key={r.label} color={selected ? theme.accent : undefined} bold={selected}>
                {selected ? "❯ " : "  "}
                {r.label}
                <Text color={theme.muted}>
                  {"  "}
                  {r.path}
                </Text>
                {r.exists ? null : (
                  <Text color={theme.warning}>
                    {" · "}
                    {t("imagesMissing")}
                  </Text>
                )}
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>
              {"  "}
              {tc("moreBelow", { count: win.below })}
            </Text>
          ) : null}
        </>
      )}
      <OverlayFooter hint={t("imagesFooter")} />
    </Box>
  )
}
