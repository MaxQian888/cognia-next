/**
 * `window.showOpenDialog` / `showSaveDialog` on the desktop's native file
 * dialogs. Options arrive in VS Code's shape and answers leave as `file:`
 * URIs. Outside the desktop app there is no native dialog to open, and the
 * call fails saying so rather than pretending the user cancelled.
 */

import { isTauri } from "@/lib/platform/detect"
import { fileUriToPath, pathToFileUri } from "@/lib/files/path-uri"

import type { VscodeOpenDialogOptions, VscodeSaveDialogOptions } from "./window-handlers"

type DialogFilter = { name: string; extensions: string[] }

export interface NativeDialogs {
  open(options: {
    directory: boolean
    multiple: boolean
    defaultPath?: string
    filters?: DialogFilter[]
    title?: string
  }): Promise<string | string[] | null>
  save(options: {
    defaultPath?: string
    filters?: DialogFilter[]
    title?: string
  }): Promise<string | null>
}

async function tauriDialogs(): Promise<NativeDialogs> {
  if (!isTauri()) {
    throw new Error("File dialogs need the Cognia desktop app")
  }
  const dialog = await import("@tauri-apps/plugin-dialog")
  return { open: (options) => dialog.open(options), save: (options) => dialog.save(options) }
}

function filtersOf(filters: Record<string, string[]> | undefined): DialogFilter[] | undefined {
  if (!filters) return undefined
  const list = Object.entries(filters).map(([name, extensions]) => ({ name, extensions }))
  return list.length > 0 ? list : undefined
}

function defaultPathOf(uri: string | undefined): string | undefined {
  return uri ? (fileUriToPath(uri) ?? undefined) : undefined
}

export async function pickOpenUris(
  options: VscodeOpenDialogOptions,
  dialogs?: NativeDialogs
): Promise<string[] | null> {
  const native = dialogs ?? (await tauriDialogs())
  // VS Code opens files unless told otherwise; folders only when asked and files not.
  const directory = options.canSelectFolders === true && options.canSelectFiles === false
  const picked = await native.open({
    directory,
    multiple: options.canSelectMany === true,
    ...(defaultPathOf(options.defaultUri)
      ? { defaultPath: defaultPathOf(options.defaultUri) }
      : {}),
    ...(!directory && filtersOf(options.filters) ? { filters: filtersOf(options.filters) } : {}),
    ...((options.title ?? options.openLabel) ? { title: options.title ?? options.openLabel } : {}),
  })
  if (picked === null) return null
  const paths = Array.isArray(picked) ? picked : [picked]
  return paths.length > 0 ? paths.map(pathToFileUri) : null
}

export async function pickSaveUri(
  options: VscodeSaveDialogOptions,
  dialogs?: NativeDialogs
): Promise<string | null> {
  const native = dialogs ?? (await tauriDialogs())
  const picked = await native.save({
    ...(defaultPathOf(options.defaultUri)
      ? { defaultPath: defaultPathOf(options.defaultUri) }
      : {}),
    ...(filtersOf(options.filters) ? { filters: filtersOf(options.filters) } : {}),
    ...((options.title ?? options.saveLabel) ? { title: options.title ?? options.saveLabel } : {}),
  })
  return picked ? pathToFileUri(picked) : null
}
