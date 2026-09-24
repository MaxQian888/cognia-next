import type {
  Character,
  ChatSession,
  ConversationSidebarMetadata,
  Team,
} from "@cognia/agent-config-types"

import { avatarColor, type AvatarSubject } from "@/lib/ui/avatar"
import type { SessionRowMetadataItem } from "../session-row"

/**
 * Everything a conversation row wears besides its own session fields: the
 * leading avatar, the accent colour, and the metadata line.
 *
 * Why a resolver and not three `useCallback`s: `SessionRow` is memoized, so any
 * prop that is rebuilt per call busts it. The previous callbacks minted a fresh
 * `AvatarSubject` object on every call and rebuilt every row's metadata array
 * whenever *any* session changed — so one streamed message re-rendered the
 * whole sidebar. A resolver instance lives exactly as long as its inputs (the
 * list recreates it when characters, teams, workspaces, defaults or the
 * metadata preference change) and, inside that lifetime, hands back the same
 * object for the same answer:
 *
 * - one `AvatarSubject` per character / team, shared by every row of it;
 * - one metadata array per session object (rows that did not change keep their
 *   identity upstream — `shareUnchangedSessions` — so they hit the cache), and
 *   equal contents interned to one array, so a row whose session changed for
 *   another reason (a new message) still gets the metadata array it had.
 */

/** The inputs the decorations are derived from. */
export interface RowDecorationSources {
  characterById: ReadonlyMap<string, Character>
  teamById: ReadonlyMap<string, Team>
  /** Workspace id → display name. */
  workspaceNameById: ReadonlyMap<string, string>
  /** Which metadata fields the row shows, in order. */
  metadataFields: readonly ConversationSidebarMetadata[]
  /** Settings → Conversation → "custom icons". Off = no avatars at all. */
  showCustomIcons: boolean
  /**
   * The merged rail's scope tree: a team row already sits under its squad's
   * header, so its `agent` field (the squad's name) is dropped.
   */
  merged: boolean
  /** Profile default model, before the built-in default. */
  defaultModel: string | undefined
  /** Profile default provider, before the built-in default. */
  defaultProvider: string | undefined
  /** The last-resort model when neither session, character nor profile names one. */
  fallbackModel: string
  /** The last-resort provider, same rule. */
  fallbackProvider: string
  /** Display names for model / provider ids. */
  labelModel: (id: string) => string
  labelProvider: (id: string) => string
}

export interface RowDecorations {
  metadataFor: (session: ChatSession) => SessionRowMetadataItem[]
  iconFor: (session: ChatSession) => AvatarSubject | undefined
  accentFor: (session: ChatSession) => string | undefined
}

const EMPTY_METADATA: SessionRowMetadataItem[] = []

/** The entity a row is drawn for: its team, or its bound character. */
function rowSubjectOf(
  session: ChatSession,
  sources: Pick<RowDecorationSources, "characterById" | "teamById">
): { key: string; subject: Character | Team } | undefined {
  if (session.kind === "team") {
    const team = session.teamId ? sources.teamById.get(session.teamId) : undefined
    return team ? { key: `team:${team.id}`, subject: team } : undefined
  }
  const character = session.characterId ? sources.characterById.get(session.characterId) : undefined
  return character ? { key: `character:${character.id}`, subject: character } : undefined
}

export function createRowDecorations(sources: RowDecorationSources): RowDecorations {
  const iconByEntity = new Map<string, AvatarSubject>()
  const accentByEntity = new Map<string, string>()
  const metadataBySession = new WeakMap<ChatSession, SessionRowMetadataItem[]>()
  const metadataBySignature = new Map<string, SessionRowMetadataItem[]>()

  const iconFor = (session: ChatSession): AvatarSubject | undefined => {
    if (!sources.showCustomIcons) return undefined
    const entity = rowSubjectOf(session, sources)
    if (!entity) return undefined
    let icon = iconByEntity.get(entity.key)
    if (!icon) {
      const { subject } = entity
      icon = {
        name: subject.name,
        avatarColor: subject.avatarColor,
        avatarEmoji: subject.avatarEmoji,
        avatarImageUrl: "avatarImage" in subject ? subject.avatarImage?.webDataUrl : undefined,
      }
      iconByEntity.set(entity.key, icon)
    }
    return icon
  }

  // Team rows inherit the team colour, direct rows their character's.
  const accentFor = (session: ChatSession): string | undefined => {
    const entity = rowSubjectOf(session, sources)
    if (!entity) return undefined
    let accent = accentByEntity.get(entity.key)
    if (accent === undefined) {
      accent = avatarColor(entity.subject)
      accentByEntity.set(entity.key, accent)
    }
    return accent
  }

  const computeMetadata = (session: ChatSession): SessionRowMetadataItem[] => {
    if (sources.metadataFields.length === 0) return EMPTY_METADATA
    const character = session.characterId
      ? sources.characterById.get(session.characterId)
      : undefined
    const valueOf = (kind: ConversationSidebarMetadata): string | undefined => {
      switch (kind) {
        case "agent":
          return session.kind === "team"
            ? session.teamId
              ? sources.teamById.get(session.teamId)?.name
              : undefined
            : character?.name
        case "model":
          return sources.labelModel(
            session.model ?? character?.model ?? sources.defaultModel ?? sources.fallbackModel
          )
        case "provider":
          return sources.labelProvider(
            session.providerOverride ??
              character?.providerId ??
              sources.defaultProvider ??
              sources.fallbackProvider
          )
        case "workspace":
          return session.projectId ? sources.workspaceNameById.get(session.projectId) : undefined
      }
    }
    const items: SessionRowMetadataItem[] = []
    for (const kind of sources.metadataFields) {
      if (sources.merged && kind === "agent" && session.kind === "team") continue
      const value = valueOf(kind)
      if (value) items.push({ kind, value })
    }
    if (items.length === 0) return EMPTY_METADATA
    // Intern by content: two rows (or two reads of one row) that say the same
    // thing share one array, so a changed session keeps its metadata identity.
    const signature = items.map((item) => `${item.kind}\u0000${item.value}`).join("\u0001")
    const interned = metadataBySignature.get(signature)
    if (interned) return interned
    metadataBySignature.set(signature, items)
    return items
  }

  const metadataFor = (session: ChatSession): SessionRowMetadataItem[] => {
    let metadata = metadataBySession.get(session)
    if (!metadata) {
      metadata = computeMetadata(session)
      metadataBySession.set(session, metadata)
    }
    return metadata
  }

  return { metadataFor, iconFor, accentFor }
}
