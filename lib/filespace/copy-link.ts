/**
 * Copy a link to one file of a conversation (ADR-0222 §2).
 *
 * The callers — the dock editor's file tree, a tool card's file row — hold an
 * absolute host path, or one relative to the conversation's working
 * directory. A link must carry the FileSpace path instead (`/workspace/…`,
 * `/roots/<id>/…`): it survives the worktree being recreated elsewhere and it
 * means the same file on another device that has the conversation. So the
 * path is re-addressed against the conversation's own FileSpace, and a path
 * outside every mount is refused rather than linked to something the link
 * could not open.
 */

import { resolveLinkPath } from "@/lib/terminal/terminal-links"
import { isTauri } from "@/lib/tauri"
import { writeClipboardText } from "@/lib/tauri/clipboard"

import { loadConversationFileSpace, type LoadedConversationFileSpace } from "./load"
import { buildConversationFilesLink } from "./links"
import { toFileSpacePath } from "./paths"

export type CopyConversationFileLinkResult = "copied" | "outside" | "failed"

export interface CopyConversationFileLinkArgs {
  sessionId: string
  /** Absolute, or relative to the conversation's `/workspace` directory. */
  path: string
  line?: number
}

export interface CopyConversationFileLinkDeps {
  load: (sessionId: string) => Promise<LoadedConversationFileSpace>
  write: (text: string) => Promise<void>
  desktop: () => boolean
}

export const defaultCopyLinkDeps: CopyConversationFileLinkDeps = {
  load: (sessionId) => loadConversationFileSpace(sessionId),
  write: writeClipboardText,
  desktop: isTauri,
}

export async function copyConversationFileLink(
  args: CopyConversationFileLinkArgs,
  deps: CopyConversationFileLinkDeps = defaultCopyLinkDeps
): Promise<CopyConversationFileLinkResult> {
  let space
  try {
    ;({ space } = await deps.load(args.sessionId))
  } catch {
    return "failed"
  }
  const workspace = space.mounts.find((mount) => mount.id === "workspace")?.hostPath
  const absolute = workspace ? resolveLinkPath(workspace, args.path) : args.path
  const path = toFileSpacePath(space, absolute)
  if (!path) return "outside"
  const link = buildConversationFilesLink(
    { sessionId: args.sessionId, path, ...(args.line ? { line: args.line } : {}) },
    { desktop: deps.desktop() }
  )
  try {
    await deps.write(link)
    return "copied"
  } catch {
    return "failed"
  }
}
