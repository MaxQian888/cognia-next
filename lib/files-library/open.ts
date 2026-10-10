/**
 * Where "Open" takes a Files entry (ADR-0200). An artifact whose conversation
 * is alive opens in that conversation's artifact panel; a canvas document
 * opens in the Canvas guild. A workspace file (ADR-0223 §8) opens in its
 * conversation's Files panel, through the opener a `view=files` link uses
 * (ADR-0222). Everything else — images, uploads, an artifact or workspace
 * file whose conversation is gone, a workspace file outside its
 * conversation's FileSpace — is previewed inside Files.
 */

import { guildFromSession } from "@/lib/claude/guild"
import { getSession } from "@/lib/db/sessions"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"
import type { FilesEntry } from "./types"

export interface FilesNavigator {
  push: (href: string) => void
}

export type FilesOpenTarget = "artifact" | "canvas" | "workspace" | "preview"

/** Where `open` will take the entry, without doing it. */
export function openTargetFor(entry: FilesEntry): FilesOpenTarget {
  if (entry.kind === "canvas") return "canvas"
  if (entry.kind === "artifact" && entry.originAlive && entry.originSessionId) return "artifact"
  if (entry.kind === "workspace-file" && entry.originAlive && entry.workspace) return "workspace"
  return "preview"
}

/** Leave Files for the entry's own surface; `"preview"` means the caller previews it in place. */
export async function openFilesEntry(
  entry: FilesEntry,
  navigator: FilesNavigator
): Promise<FilesOpenTarget> {
  const target = openTargetFor(entry)
  if (target === "canvas") {
    useArtifactStore.getState().setActiveCanvas(entry.sourceId)
    useUIStore.getState().setSelectedGuild({ kind: "canvas" })
    navigator.push("/")
    return "canvas"
  }
  if (target === "artifact") {
    return (await openArtifactInSession(entry.sourceId, entry.originSessionId!, navigator))
      ? "artifact"
      : "preview"
  }
  if (target === "workspace") {
    // Loaded on demand: the opener pulls in the FileSpace resolver.
    const { openWorkspaceFileInConversation } = await import("./workspace-files-io")
    const result = await openWorkspaceFileInConversation(entry, navigator)
    return result === "outside" ? "preview" : "workspace"
  }
  return "preview"
}

/**
 * Focus the conversation an artifact was made in and open it in that
 * conversation's artifact panel. `false` when the conversation is gone, so
 * the caller can preview in place instead. Shared with the issue
 * inspector's deliverables, which open the same way.
 */
export async function openArtifactInSession(
  artifactId: string,
  sessionId: string,
  navigator: FilesNavigator
): Promise<boolean> {
  const session = await getSession(sessionId)
  if (!session) return false
  useChatStore.getState().setActiveSession(sessionId)
  useUIStore.getState().setSelectedGuild(guildFromSession(session))
  useArtifactStore.getState().setActiveArtifact(artifactId, sessionId)
  useArtifactStore.getState().openPanel("artifact")
  navigator.push("/")
  return true
}

/** Focus a conversation and leave Files for it (after "Use in chat"). */
export async function goToSession(sessionId: string, navigator: FilesNavigator): Promise<void> {
  const session = await getSession(sessionId)
  useChatStore.getState().setActiveSession(sessionId)
  useUIStore.getState().setSelectedGuild(guildFromSession(session))
  navigator.push("/")
}
