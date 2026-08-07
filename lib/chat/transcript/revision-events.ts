import { isTauri } from "@/lib/platform/detect"

export const TRANSCRIPT_REVISION_EVENT = "transcript://revision"

export interface TranscriptRevisionEvent {
  sessionId: string
  revision: number
}

/** Publish only identity + revision; transcript content never enters event logs. */
export async function publishTranscriptRevision(
  sessionId: string,
  revision: number
): Promise<void> {
  const payload: TranscriptRevisionEvent = { sessionId, revision }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(TRANSCRIPT_REVISION_EVENT, { detail: payload }))
  }
  if (!isTauri()) return
  try {
    const moduleId = "@tauri-apps/api/event"
    const event = (await import(/* webpackIgnore: true */ moduleId)) as {
      emit: (name: string, value: unknown) => Promise<void>
    }
    await event.emit(TRANSCRIPT_REVISION_EVENT, payload)
  } catch {
    // Best effort: persisted revision remains authoritative for reconnect.
  }
}
