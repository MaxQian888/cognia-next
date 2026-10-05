/** JSON answers and the protocol's error shape (`{error, message?}`, protocol §16). */

import type { SyncErrorCode } from "@cognia/sync-protocol"

export const SERVER_TIME_HEADER = "cognia-server-time"

export class SyncHttpError extends Error {
  readonly status: number
  readonly code:
    SyncErrorCode | "not_found" | "payload_too_large" | "server_misconfigured" | "internal_error"

  constructor(status: number, code: SyncHttpError["code"], message?: string) {
    super(message ?? code)
    this.name = "SyncHttpError"
    this.status = status
    this.code = code
  }
}

/** What the space returns to the Worker: plain data, so it crosses RPC as is. */
export interface SpaceReply {
  status: number
  body: unknown
}

export function reply(body: unknown, status = 200): SpaceReply {
  return { status, body }
}

export function errorReply(error: SyncHttpError): SpaceReply {
  const body: { error: string; message?: string } = { error: error.code }
  if (error.message !== error.code) body.message = error.message
  return { status: error.status, body }
}

export function toResponse(result: SpaceReply, now: number): Response {
  return Response.json(result.body, {
    status: result.status,
    headers: { [SERVER_TIME_HEADER]: String(now), "cache-control": "no-store" },
  })
}
