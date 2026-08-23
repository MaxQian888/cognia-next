export type MobileStepReceiptStatus = "executing" | "result-pending" | "acknowledged"

/** Device-local replay guard and durable result receipt for one interactive step. */
export interface MobileStepReceiptRow {
  requestId: string
  deviceId: string
  accountId: string
  targetId: string
  kind: string
  status: MobileStepReceiptStatus
  createdAt: number
  updatedAt: number
  timeoutAt: number
  /** Sensitive serialized result, retained only until every Host ACK arrives. */
  resultJson?: string
  resultChunkCount?: number
  acknowledgedChunks?: number[]
  /** Content-free acknowledgement tombstones expire after 24 hours. */
  expiresAt?: number
}
