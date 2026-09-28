/**
 * Where "Open" takes a Files entry (ADR-0200). An artifact whose conversation
 * is alive opens in that conversation's artifact panel; a canvas document
 * opens in the Canvas guild. Everything else — images, uploads, and an
 * artifact whose conversation is gone — is previewed inside Files.
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

export type FilesOpenTarget = "artifact" | "canvas" | "preview"

/** Where `open` will take the entry, without doing it. */
export function openTargetFor(entry: FilesEntry): FilesOpenTarget {
  if (entry.kind === "canvas") return "canvas"
  if (entry.kind === "artifact" && entry.originAlive && entry.originSessionId) return "artifact"
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
    const sessionId = entry.originSessionId!
    const session = await getSession(sessionId)
    if (!session) return "preview"
    useChatStore.getState().setActiveSession(sessionId)
    useUIStore.getState().setSelectedGuild(guildFromSession(session))
    useArtifactStore.getState().setActiveArtifact(entry.sourceId, sessionId)
    useArtifactStore.getState().openPanel("artifact")
    navigator.push("/")
    return "artifact"
  }
  return "preview"
}

/** Focus a conversation and leave Files for it (after "Use in chat"). */
export async function goToSession(sessionId: string, navigator: FilesNavigator): Promise<void> {
  const session = await getSession(sessionId)
  useChatStore.getState().setActiveSession(sessionId)
  useUIStore.getState().setSelectedGuild(guildFromSession(session))
  navigator.push("/")
}
