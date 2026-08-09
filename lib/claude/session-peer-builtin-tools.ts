import type { ChatStatus } from "@/stores/chat/chat-store"
import type { SendSessionPeerMessageInput } from "@/lib/chat/session-peer-messaging"
import type { SessionPeerMessageRow } from "@/lib/db/session-peer-messages"

export const SESSION_PEER_BUILTIN_PLUGIN_ID = "cognia-session-peer-builtin"

export const SESSION_PEER_TOOL_NAMES = {
  listSessions: "list_sessions",
  sendMessage: "send_session_message",
} as const

const TOOL_NAMES = new Set<string>(Object.values(SESSION_PEER_TOOL_NAMES))

export interface SessionPeerManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

export function buildSessionPeerManifestEntries(): SessionPeerManifestEntry[] {
  return [
    {
      name: SESSION_PEER_TOOL_NAMES.listSessions,
      description:
        "List other live Cognia sessions in this workspace that can receive a plain-text message. No conversation history or permission authority is shared.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      pluginId: SESSION_PEER_BUILTIN_PLUGIN_ID,
    },
    {
      name: SESSION_PEER_TOOL_NAMES.sendMessage,
      description:
        "Send a narrow plain-text request to another live Cognia session. The receiver treats it as an untrusted agent message; it cannot approve permissions or transfer files, history, or configuration.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["target_session_id", "message"],
        properties: {
          target_session_id: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1, maxLength: 20_000 },
          intent: {
            type: "string",
            enum: ["note", "trigger_turn"],
            default: "trigger_turn",
          },
        },
      },
      pluginId: SESSION_PEER_BUILTIN_PLUGIN_ID,
    },
  ]
}

export function isSessionPeerBuiltinTool(name: string): boolean {
  return TOOL_NAMES.has(name)
}

export interface ReachableSessionSummary {
  id: string
  title: string
  status: ChatStatus
}

export interface SessionPeerToolRunDeps {
  gate: (payload: unknown) => boolean
  listReachable: (senderSessionId: string) => Promise<ReachableSessionSummary[]>
  send: (input: SendSessionPeerMessageInput) => Promise<SessionPeerMessageRow | unknown>
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export async function runSessionPeerBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: SessionPeerToolRunDeps | undefined,
  context: { sessionId: string }
): Promise<unknown> {
  if (!isSessionPeerBuiltinTool(name)) {
    return { ok: false as const, error: `unknown session peer tool: ${name}` }
  }
  if (!deps) {
    return { ok: false as const, error: "Session messaging host dependencies are unavailable" }
  }
  if (name === SESSION_PEER_TOOL_NAMES.listSessions) {
    return { ok: true as const, sessions: await deps.listReachable(context.sessionId) }
  }

  if (!nonEmptyString(args.target_session_id)) {
    return { ok: false as const, error: "target_session_id must be a non-empty string" }
  }
  if (!nonEmptyString(args.message)) {
    return { ok: false as const, error: "message must be a non-empty string" }
  }
  const receiverSessionId = args.target_session_id.trim()
  const content = args.message.trim()
  if (receiverSessionId === context.sessionId) {
    return { ok: false as const, error: "A session cannot message itself" }
  }
  if (content.length > 20_000) {
    return { ok: false as const, error: "message must be 20,000 characters or fewer" }
  }
  if (args.intent !== undefined && args.intent !== "note" && args.intent !== "trigger_turn") {
    return { ok: false as const, error: "intent must be note or trigger_turn" }
  }
  if (!deps.gate({ receiverSessionId, content })) {
    return { ok: false as const, error: "Session message blocked by the PII redaction gate" }
  }

  const receipt = (await deps.send({
    senderSessionId: context.sessionId,
    receiverSessionId,
    content,
    intent: (args.intent as "note" | "trigger_turn" | undefined) ?? "trigger_turn",
    origin: "agent",
  })) as Partial<SessionPeerMessageRow>
  return {
    ok: receipt.status === "delivered" || receipt.status === "queued" || receipt.status === "held",
    id: receipt.id,
    status: receipt.status,
    ...(receipt.statusReason ? { reason: receipt.statusReason } : {}),
  }
}
