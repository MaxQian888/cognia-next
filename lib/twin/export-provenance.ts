import type { ChatSession } from "@cognia/agent-config-types"
import type { ShareProvenance } from "@/lib/share/types"
import { twinShareProvenance } from "./outbound-disclosure"
import type { UIMessage } from "ai"

export async function resolveSessionTwinProvenance(
  session: ChatSession,
  messages: readonly Array<{ metadata?: unknown }> = [],
  getCharacter: (id: string) => Promise<{ twinId?: string } | undefined> = async (id) =>
    (await import("@/lib/db/schema")).getDb().characters.get(id)
): Promise<ShareProvenance[] | undefined> {
  const durable = messages.flatMap((message) => {
    const metadata = message.metadata as { provenance?: ShareProvenance[] } | undefined
    return metadata?.provenance ?? []
  })
  const twins = durable
    .filter((entry) => entry.source === "digital-twin")
    .filter(
      (entry, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.source === entry.source &&
            candidate.sourceId === entry.sourceId &&
            candidate.disclosure === entry.disclosure
        ) === index
    )
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  if (twins.length) return twins
  if (!session.characterId) return undefined
  const character = await getCharacter(session.characterId)
  return character?.twinId ? twinShareProvenance(character.twinId) : undefined
}

/** Persist Twin provenance on the assistant message that used Twin context. */
export function attachTwinProvenanceToLastAssistant(
  messages: readonly UIMessage[],
  twinId: string
): UIMessage[] {
  const index = [...messages].map((message) => message.role).lastIndexOf("assistant")
  if (index < 0) return [...messages]
  return messages.map((message, messageIndex) => {
    if (messageIndex !== index) return message
    const metadata = (message.metadata ?? {}) as Record<string, unknown>
    return {
      ...message,
      metadata: { ...metadata, provenance: twinShareProvenance(twinId) },
    }
  })
}
