import type {
  SessionTimelinePage,
  SessionTimelineRequest,
  SessionTurnMessagesPage,
  SessionTurnMessagesRequest,
  StoredMessage,
  TranscriptCapabilitiesV1,
} from "@cognia/agent-config-types"
import {
  TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
  TRANSCRIPT_DETAIL_PAGE_MAX,
  TRANSCRIPT_PROTOCOL_VERSION,
  TRANSCRIPT_SUMMARY_BYTE_LIMIT,
  TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
  TRANSCRIPT_TIMELINE_PAGE_MAX,
} from "@cognia/agent-config-types"
import type { Transport } from "@/lib/tauri/transport-types"

import { projectTranscriptTimeline } from "./projection"

export interface TranscriptSource {
  capabilities(): Promise<TranscriptCapabilitiesV1 | null>
  timeline(request: SessionTimelineRequest): Promise<SessionTimelinePage>
  turnMessages(request: SessionTurnMessagesRequest): Promise<SessionTurnMessagesPage>
  subscribeRevision?(sessionId: string, listener: (revision: number) => void): () => void
}

interface LegacyMessagePage {
  rows: StoredMessage[]
  next_offset?: number
}

export function transcriptCapabilitiesV1(): TranscriptCapabilitiesV1 {
  return {
    version: TRANSCRIPT_PROTOCOL_VERSION,
    maxTimelinePageSize: TRANSCRIPT_TIMELINE_PAGE_MAX,
    maxTurnMessagePageSize: TRANSCRIPT_DETAIL_PAGE_MAX,
    maxTurnMessagePageBytes: TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
    maxSummaryBytes: TRANSCRIPT_SUMMARY_BYTE_LIMIT,
    maxSummaryMediaRefs: TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
    mediaVariants: ["thumbnail", "canonical"],
  }
}

function isMethodNotFound(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined
  const code = record?.code
  const status = record?.status ?? record?.statusCode
  const message = error instanceof Error ? error.message : String(record?.message ?? "")
  return (
    code === -32601 ||
    code === "METHOD_NOT_FOUND" ||
    status === 404 ||
    status === 405 ||
    /\bmethod not found\b/i.test(message)
  )
}

async function loadLegacyMessages(
  transport: Transport,
  sessionId: string
): Promise<StoredMessage[]> {
  const rows: StoredMessage[] = []
  let offset: number | undefined = 0
  do {
    const page: LegacyMessagePage = await transport.call<LegacyMessagePage>(
      "message_get_by_session",
      {
        session_id: sessionId,
        limit: 200,
        offset,
      }
    )
    rows.push(...page.rows)
    offset = page.next_offset
  } while (offset !== undefined)
  return rows
}

/**
 * Transcript adapter for Companion/RTC transports.
 *
 * Capability absence is the only downgrade path. Once the host advertises V1,
 * timeouts, stale revisions, authorization failures, and server errors remain
 * visible to the controller instead of triggering an unbounded legacy read.
 */
export function createRemoteTranscriptSource(transport: Transport): TranscriptSource {
  let capabilityState: TranscriptCapabilitiesV1 | null | undefined

  const capabilities = async (): Promise<TranscriptCapabilitiesV1 | null> => {
    if (capabilityState !== undefined) return capabilityState
    try {
      capabilityState = await transport.call<TranscriptCapabilitiesV1>(
        "transcript_capabilities",
        {}
      )
      return capabilityState
    } catch (error) {
      if (!isMethodNotFound(error)) throw error
      capabilityState = null
      return null
    }
  }

  return {
    capabilities,
    subscribeRevision(sessionId, listener) {
      return transport.subscribe<{ sessionId?: string; revision?: number }>(
        "transcript://revision",
        (event) => {
          if (event.sessionId !== sessionId || typeof event.revision !== "number") return
          listener(event.revision)
        }
      )
    },
    async timeline(request) {
      const supported = await capabilities()
      if (supported) {
        return transport.call<SessionTimelinePage>("session_timeline", {
          session_id: request.sessionId,
          direction: request.direction,
          cursor: request.cursor,
          limit: request.limit,
        })
      }
      const rows = await loadLegacyMessages(transport, request.sessionId)
      const items = projectTranscriptTimeline({
        sessionId: request.sessionId,
        revision: 0,
        messages: rows,
      })
      const limit = Math.min(Math.max(request.limit ?? 30, 1), TRANSCRIPT_TIMELINE_PAGE_MAX)
      return { items: items.slice(-limit), revision: 0, hasMore: items.length > limit }
    },
    async turnMessages(request) {
      const supported = await capabilities()
      if (supported) {
        return transport.call<SessionTurnMessagesPage>("session_turn_messages", {
          session_id: request.sessionId,
          turn_key: request.turnKey,
          revision: request.revision,
          detail_revision: request.detailRevision,
          cursor: request.cursor,
          limit: request.limit,
        })
      }
      const rows = await loadLegacyMessages(transport, request.sessionId)
      const messages = rows.filter(
        (message) => message.turnKey === request.turnKey || `turn:${message.id}` === request.turnKey
      )
      const approximateBytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength
      return {
        messages: messages.map((message) => ({
          id: message.id,
          sessionId: message.sessionId,
          ...(message.turnKey ? { turnKey: message.turnKey } : {}),
          role: message.role,
          parts: message.parts,
          ...(message.senderId ? { senderId: message.senderId } : {}),
          ...(message.senderKind ? { senderKind: message.senderKind } : {}),
          ...(message.metadata ? { metadata: message.metadata } : {}),
          createdAt: message.createdAt,
        })),
        revision: 0,
        detailRevision: 0,
        total: messages.length,
        approximateBytes,
        hasMore: false,
      }
    },
  }
}
