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

const CHOICES = [{ label: "Yes, proceed" }, { label: "Choose another folder…" }] as const

export function StartupGate({
  cwd,
  onTrust,
  onChangeCwd,
  listDirs,
}: {
  cwd: string
  /** Trust the current cwd and enter chat. */
  onTrust: () => void
  /** Switch to `dir`, trust it, and enter chat. */
  onChangeCwd: (dir: string) => void
  listDirs?: ListDirs
}) {
  const [picking, setPicking] = useState(false)
  const [index, setIndex] = useState(0)

  if (picking) {
    return (
      <FolderPicker
        initialDir={cwd}
        onConfirm={onChangeCwd}
        onCancel={() => setPicking(false)}
        listDirs={listDirs}
      />
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        Do you trust the files in <Text color="cyan">{shortenCwd(cwd, 60)}</Text>?
      </Text>
      <Text color="gray" dimColor>
        Cognia Agent may read and edit files and run commands in this folder.
      </Text>
      <SelectList
        items={CHOICES.map((c) => ({ label: c.label }))}
        index={index}
        onMove={(delta) => setIndex((cur) => moveIndex(cur, delta, CHOICES.length))}
        onSelect={(i) => (i === 0 ? onTrust() : setPicking(true))}
      />
    </Box>
  )
}
