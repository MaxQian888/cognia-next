export interface ConversationMessage {
  role: string
  content?: unknown
  [field: string]: unknown
}
