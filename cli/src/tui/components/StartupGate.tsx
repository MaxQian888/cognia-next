/**
 * The startup trust gate — Claude Code's "Do you trust the files in this folder?"
 * onboarding, shown once per untrusted folder before the chat opens.
 *
 * Reuses {@link SelectList} for the choice. "Yes, proceed" trusts the current
 * folder; "Choose another folder…" swaps to the {@link FolderPicker}. Picking a
 * folder there both switches the working directory and proceeds (an explicitly
 * chosen folder is trusted implicitly). All side effects are props so the App
 * owns persistence + state.
 */
import React, { useState } from "react"
import { Box, Text } from "ink"

import { SelectList } from "./SelectList"
import { FolderPicker, type ListDirs } from "./FolderPicker"
import { moveIndex } from "./select-list-state"
import { shortenCwd } from "../format/usage"
import { useTheme } from "../theme/context"

const CHOICES = [{ label: "Yes, proceed" }, { label: "Choose another folder…" }] as const

export function StartupGate({
  cwd,
  onTrust,
  onChangeCwd,
  listDirs,
  width,
  maxRows,
}: {
  cwd: string
  /** Trust the current cwd and enter chat. */
  onTrust: () => void
  /** Switch to `dir`, trust it, and enter chat. */
  onChangeCwd: (dir: string) => void
  listDirs?: ListDirs
  /** Terminal columns so the gate spans the full width. */
  width?: number | string
  /** Row budget so the folder picker scrolls instead of overflowing. */
  maxRows?: number
}) {
  const theme = useTheme()
  const [picking, setPicking] = useState(false)
  const [index, setIndex] = useState(0)

  if (picking) {
    return (
      <FolderPicker
        initialDir={cwd}
        onConfirm={onChangeCwd}
        onCancel={() => setPicking(false)}
        listDirs={listDirs}
        width={width}
        maxRows={maxRows}
      />
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text>
        Do you trust the files in <Text color={theme.accent}>{shortenCwd(cwd, 60)}</Text>?
      </Text>
      <Text color={theme.muted} dimColor>
        Cognia Agent may read and edit files and run commands in this folder.
      </Text>
      <SelectList
        items={CHOICES.map((c) => ({ label: c.label }))}
        index={index}
        width={width}
        maxRows={maxRows}
        onMove={(delta) => setIndex((cur) => moveIndex(cur, delta, CHOICES.length))}
        onSelect={(i) => (i === 0 ? onTrust() : setPicking(true))}
      />
    </Box>
  )
}
