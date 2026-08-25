"use client"

// Load `.cognia/templates/*.md` for the workspace this conversation runs in.
//
// Gated on Workspace Trust, and on the SAME verdict the send path uses — not a
// second, kinder one written for a picker. A checkout you have not trusted does
// not get to put text into your composer, propose a system prompt, or name a
// model, any more than it gets to run its setup script.
//
// Nothing here writes. A repository template is a file in a repository: edited
// with the editor, reviewed in a pull request, versioned by git.

import { useEffect, useState } from "react"

import { loggers } from "@cognia/logging"
import {
  REPO_TEMPLATE_DIR,
  REPO_TEMPLATE_MAX_BYTES,
  parseRepoTemplate,
  type RepoChatTemplate,
} from "@/lib/chat/template/repo-templates"

/** How many files one checkout may contribute. A picker is not a file browser. */
const MAX_FILES = 50

export interface RepoChatTemplateDeps {
  listDir(root: string, relPath: string): Promise<{ relPath: string; isDir: boolean }[]>
  readFile(root: string, relPath: string, maxBytes: number): Promise<string>
  isRestricted(root: string): Promise<boolean>
}

/**
 * Every field lazy, so a caller injecting all of them (tests) does not drag
 * Dexie, the settings store and the filesystem bridge in behind them.
 */
const DEFAULT_DEPS: RepoChatTemplateDeps = {
  listDir: async (root, relPath) => {
    const { listWorkspaceDir } = await import("@/lib/files/workspace-fs")
    return listWorkspaceDir(root, relPath)
  },
  readFile: async (root, relPath, maxBytes) => {
    const { readWorkspaceFile } = await import("@/lib/files/workspace-fs")
    return readWorkspaceFile(root, relPath, maxBytes)
  },
  isRestricted: async (root) => {
    const [{ isWorkspaceRestricted }, { useSettingsStore }, { isTauri }] = await Promise.all([
      import("@/lib/workspace/trust-gate"),
      import("@/stores/settings"),
      import("@/lib/tauri"),
    ])
    // A single-root stand-in for the directory the templates are actually being
    // read from. Asking about the ACTIVE project instead would answer about a
    // different checkout whenever the session overrides its working directory.
    return isWorkspaceRestricted(
      { roots: [{ id: root, path: root, isPrimary: true }] },
      {
        enabled: useSettingsStore.getState().settings?.workspaceTrust?.enabled !== false,
        onWeb: !isTauri(),
      }
    )
  },
}

export async function loadRepoChatTemplates(
  root: string | null | undefined,
  deps: Partial<RepoChatTemplateDeps> = {}
): Promise<RepoChatTemplate[]> {
  const cwd = root?.trim()
  if (!cwd) return []
  const resolved: RepoChatTemplateDeps = { ...DEFAULT_DEPS, ...deps }

  // Trust first, and before the listing: an untrusted checkout's templates are
  // not read, not parsed, and not counted.
  if (await resolved.isRestricted(cwd).catch(() => true)) return []

  let entries: { relPath: string; isDir: boolean }[]
  try {
    entries = await resolved.listDir(cwd, REPO_TEMPLATE_DIR)
  } catch {
    // Overwhelmingly: the directory does not exist. Most repositories have no
    // templates, and that is not a condition worth a log line per keystroke.
    return []
  }

  const files = entries
    .filter((entry) => !entry.isDir && /\.mdx?$/i.test(entry.relPath))
    .slice(0, MAX_FILES)

  const parsed = await Promise.all(
    files.map(async (file) => {
      try {
        return parseRepoTemplate(
          file.relPath,
          await resolved.readFile(cwd, file.relPath, REPO_TEMPLATE_MAX_BYTES)
        )
      } catch (err) {
        loggers.chat.warn("repository template unreadable", {
          path: file.relPath,
          err: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    })
  )

  // Two files whose names collide after the extension is stripped (`a.md` and
  // `a.mdx`) would share an id, and a draft holding that id could not say which
  // one it quoted. First one listed wins, deterministically.
  const seen = new Set<string>()
  return parsed.filter((template): template is RepoChatTemplate => {
    if (!template || seen.has(template.id)) return false
    seen.add(template.id)
    return true
  })
}

/** The checkout's templates for `root`, reloaded whenever the root changes. */
export function useRepoChatTemplates(root: string | null | undefined): RepoChatTemplate[] {
  const [templates, setTemplates] = useState<RepoChatTemplate[]>([])

  useEffect(() => {
    let cancelled = false
    void loadRepoChatTemplates(root).then((next) => {
      if (!cancelled) setTemplates(next)
    })
    return () => {
      cancelled = true
    }
  }, [root])

  return templates
}
