import { transport } from "@/lib/tauri"

export interface PersonModelTicket {
  ticketId: string
  secret: string
  endpoint: string
  gatewayPort: number
  provider: string
  model: string
  expiresAt: number
  credentialFingerprint: string
}

/** Uses the partition transport/token; never reads the Host's provider keys. */
export async function mintPersonModelTicket(
  provider: string,
  model: string,
  sessionId: string
): Promise<PersonModelTicket> {
  // CompanionTransport supplies a UUID Idempotency-Key and reuses it across
  // transport retries for this required-idempotency command.
  const ticket = await transport.call<PersonModelTicket>("person_model_ticket_mint", {
    provider,
    model,
    sessionId,
  })
  if (
    !ticket ||
    typeof ticket.secret !== "string" ||
    !ticket.secret ||
    typeof ticket.ticketId !== "string" ||
    !ticket.ticketId ||
    typeof ticket.credentialFingerprint !== "string" ||
    !ticket.credentialFingerprint ||
    ticket.provider !== provider ||
    ticket.model !== model ||
    !Number.isFinite(ticket.expiresAt) ||
    !Number.isInteger(ticket.gatewayPort) ||
    ticket.gatewayPort < 1 ||
    ticket.gatewayPort > 65535 ||
    ticket.endpoint !== `http://127.0.0.1:${ticket.gatewayPort}/v1`
  )
    throw Object.assign(new Error("malformed_request"), { code: "malformed_request" })
  return ticket
}

/** Keep Host refusals machine readable without reflecting bodies or secrets. */
export function personChatFailure(error: unknown): { code: string; resetAt?: number | string } {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {}
  const code = typeof value.code === "string" ? value.code : "runtime_dispatch_failed"
  const resetAt = value.resetAt
  return {
    code,
    ...(typeof resetAt === "string" || (typeof resetAt === "number" && Number.isFinite(resetAt))
      ? { resetAt }
      : {}),
  }
}
