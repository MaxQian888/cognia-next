/** Provider extensions remain opaque at the stream translation boundary. */
export type ProviderMetadata = Record<string, Record<string, unknown>>
export interface AiStreamEvent {
  type?: string
  text?: string
  textDelta?: string
  delta?: string
  inputTextDelta?: string
  messageId?: string
  messageMetadata?: unknown
  providerMetadata?: ProviderMetadata
  file?: { base64?: string; mediaType?: string }
  url?: string
  mediaType?: string
  data?: string
  filename?: string
  title?: string
  sourceType?: string
  toolCallId?: string
  id?: string
  toolName?: string
  args?: unknown
  input?: unknown
  toolCall?: AiStreamEvent
  providerExecuted?: boolean
  toolMetadata?: Record<string, unknown>
  dynamic?: boolean
  invalid?: boolean
  error?: unknown
  errorText?: string
  approvalId?: string
  signature?: string
  output?: unknown
  result?: unknown
  isError?: boolean
  usage?: unknown
  totalUsage?: unknown
  finishReason?: string
}
export interface EventAdapterContext {
  sessionId: string
  sdkSessionId: string
  provider: string
  model?: string
  toolNameAliases?: ReadonlyMap<string, string>
  startedAt?: number
}
export interface Citation {
  type: string
  url?: string
  title?: string
  document_title?: string
}
export interface EventBlock {
  type: string
  id?: string
  name?: string
  input?: unknown
  state?: string
  approval?: { id: string; signature?: string }
  text?: string
  thinking?: string
  providerMetadata?: ProviderMetadata
  toolMetadata?: Record<string, unknown>
  citations?: Citation[]
  content?: string | unknown[]
  tool_use_id?: string
  is_error?: boolean
  source?: { type: string; media_type?: string; data?: string }
  url?: string
  media_type?: string
  filename?: string
  [field: string]: unknown
}
export interface TranslatedEvent extends Record<string, unknown> {
  type: string
  session_id?: string
  message?: {
    id?: string
    type?: string
    role: string
    model?: string
    content: EventBlock[]
    stop_reason?: string | null
    stop_sequence?: null
    metadata?: unknown
  }
  event?: {
    type: string
    message?: { id: string }
    delta?: { type: string; text?: string; thinking?: string }
  }
  usage?: ReturnType<typeof import("../../providers/usage-normalize.ts").normalizeUsageBlock>
}
