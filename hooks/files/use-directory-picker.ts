"use client"

import { useCallback, useState } from "react"

import { pickDirectory } from "@/lib/files/file-bridge"
import { isTauri } from "@/lib/tauri"

/**
 * The one answer to "can this shell choose a directory, and what happens when
 * it cannot".
 *
 * # Why a hook and not one component
 *
 * `DirectoryField` already pairs an `<Input>` with a Browse button, and its
 * docstring claims six settings surfaces do that by hand. They never migrated,
 * and three of them ended up rendering a Browse button that silently does
 * nothing off Tauri, which is the exact failure that component was written to
 * prevent. Forcing all of them into `DirectoryField` would redesign eight
 * surfaces, since several use a compact icon button rather than a labelled one.
 *
 * So the shared thing is the DECISION, not the layout: every caller asks
 * {@link DirectoryPicker.available} before rendering an affordance, and gets
 * the same `browse()` when it does. `DirectoryField` is the convenience
 * wrapper for the common layout.
 *
 * # Why there is no remote fallback here
 *
 * A paired host can list directories over `fs_list_workspace_dir`, and
 * `WorkspaceFolderPicker` already does exactly that. It is deliberately NOT
 * wired in as a general fallback: the host runs every such request through
 * `authorize_workspace_root`, which admits only a REGISTERED workspace root
 * (or, headless, the spawn policy's root). A clone destination, an agent cwd
 * or a backup directory is not one, so a generic remote browser would open
 * straight onto a refusal. The two surfaces whose path genuinely IS a
 * workspace root use that picker directly and are not routed through here.
 *
 * Off Tauri the text input is therefore the real control, everywhere.
 */
export interface DirectoryPicker {
  /**
   * True when a directory can actually be chosen. Render the affordance only
   * when this is true. A present-and-inert button is worse than none: the user
   * clicks, nothing happens, and nothing says why.
   */
  available: boolean
  /** Open the picker. Resolves null when cancelled, or when none exists. */
  browse: () => Promise<string | null>
  /** True while the picker is open, for disabling the trigger. */
  busy: boolean
}

export interface UseDirectoryPickerOptions {
  /** Native dialog title. Optional, so most callers take the platform default. */
  title?: string
  /** Injected in tests. Defaults to the native picker. */
  pick?: (title?: string) => Promise<string | null>
  /** Injected in tests. Defaults to the real shell check. */
  hasPicker?: () => boolean
}

export function useDirectoryPicker(options: UseDirectoryPickerOptions = {}): DirectoryPicker {
  const { title, pick = pickDirectory, hasPicker = isTauri } = options
  const [busy, setBusy] = useState(false)

  const browse = useCallback(async () => {
    if (!hasPicker()) return null
    setBusy(true)
    try {
      // `pickDirectory` resolves null off Tauri rather than throwing, and the
      // native dialog rejects only on a real platform error. A caller that
      // wants to report one wraps this. A caller that does not is never left
      // with an unhandled rejection.
      return await pick(title)
    } finally {
      setBusy(false)
    }
  }, [hasPicker, pick, title])

  return { available: hasPicker(), browse, busy }
}
