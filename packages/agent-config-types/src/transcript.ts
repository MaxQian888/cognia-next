import type { UIMessage } from "ai"

export const TRANSCRIPT_PROTOCOL_VERSION = 1 as const
export const TRANSCRIPT_TIMELINE_PAGE_DEFAULT = 30
export const TRANSCRIPT_TIMELINE_PAGE_MAX = 100
export const TRANSCRIPT_DETAIL_PAGE_DEFAULT = 100
export const TRANSCRIPT_DETAIL_PAGE_MAX = 200
export const TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT = 2 * 1024 * 1024
export const TRANSCRIPT_SUMMARY_BYTE_LIMIT = 64 * 1024
export const TRANSCRIPT_SUMMARY_MEDIA_LIMIT = 12

export type TranscriptMediaVariant = "thumbnail" | "canonical"
export type TranscriptDirection = "backward" | "forward"
export type TranscriptErrorCode =
  | "INVALID_PARAMS"
  /** This host does not hold the named session; it is not a malformed request. */
  | "SESSION_NOT_FOUND"
  | "TRANSCRIPT_STALE"
  | "TURN_NOT_FOUND"
  | "TURN_NOT_COMPLETED"
  | "MEDIA_NOT_FOUND"

export interface TranscriptCapabilitiesV1 {
  version: typeof TRANSCRIPT_PROTOCOL_VERSION
  maxTimelinePageSize: number
  maxTurnMessagePageSize: number
  maxTurnMessagePageBytes: number
  maxSummaryBytes: number
  maxSummaryMediaRefs: number
  mediaVariants: TranscriptMediaVariant[]
}

export interface SessionTimelineRequest {
  sessionId: string
  direction?: TranscriptDirection
  cursor?: string
  limit?: number
}

export interface SessionTurnMessagesRequest {
  sessionId: string
  turnKey: string
  revision: number
  detailRevision: number
  cursor?: string
  limit?: number
}

/** Full message shape used only by active turns and lazily fetched details. */
export interface TranscriptMessage {
  id: string
  sessionId: string
  turnKey?: string
  role: UIMessage["role"]
  parts: UIMessage["parts"]
  senderId?: string
  senderKind?: "user" | "assistant" | "system"
  metadata?: Record<string, unknown>
  createdAt: number
}

export interface TranscriptMediaReference {
  ref: string
  mediaType?: string
  filename?: string
}

/** Small, display-safe projection. Tool inputs/results and reasoning are omitted. */
export interface TranscriptMessagePreview {
  id: string
  role: UIMessage["role"]
  text?: string
  media?: TranscriptMediaReference[]
  createdAt: number
  truncated?: boolean
}

export interface TranscriptCollapsedDetail {
  exists: boolean
  messageCount: number
  trailingCount: number
  mediaCount: number
}

export interface TranscriptBranchGroupSummary {
  groupId: string
  selectedMessageId: string
  messageIds: string[]
}

export interface TranscriptBranchSummary {
  groups: TranscriptBranchGroupSummary[]
}

interface TranscriptTimelineItemBase {
  itemKey: string
  revision: number
  startedAt: number
  completedAt?: number
  durationMs?: number
}

export interface CompletedTurnTimelineItem extends TranscriptTimelineItemBase {
  kind: "completed-turn"
  turnKey: string
  detailRevision: number
  status: "completed" | "failed"
  userMessages: TranscriptMessagePreview[]
  finalResponse?: TranscriptMessagePreview
  visibleResult?: TranscriptMessagePreview
  collapsed: TranscriptCollapsedDetail
  branchSummary?: TranscriptBranchSummary
}

export interface ActiveTurnTimelineItem extends TranscriptTimelineItemBase {
  kind: "active-turn"
  turnKey: string
  status: "active"
  messages: TranscriptMessage[]
}

export interface SystemTimelineItem extends TranscriptTimelineItemBase {
  kind: "system"
  status: "completed"
  message: TranscriptMessagePreview
}

export type TranscriptTimelineItem =
  CompletedTurnTimelineItem | ActiveTurnTimelineItem | SystemTimelineItem

export interface SessionTimelinePage {
  items: TranscriptTimelineItem[]
  revision: number
  nextCursor?: string
  hasMore: boolean
}

export interface SessionTurnMessagesPage {
  messages: TranscriptMessage[]
  revision: number
  detailRevision: number
  total: number
  approximateBytes: number
  nextCursor?: string
  hasMore: boolean
}

export interface TranscriptProtocolError {
  code: TranscriptErrorCode
  message?: string
}
