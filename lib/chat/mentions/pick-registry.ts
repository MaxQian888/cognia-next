/**
 * Mention pick-handler registry — one registration per mentionable kind.
 *
 * Replaces the composer's hand-written `if/else` dispatch in
 * `onPickPopoverItem` (`components/chat/composer.tsx`) for the mention-style
 * kinds. Adding a new referenceable kind becomes a `registerMentionPickHandler`
 * call instead of a composer edit. `slash` and `memory` picks are command /
 * param-form flows, not mentions, and stay in the composer.
 *
 * Registry style follows `lib/plugin/registries/*` (module-level map,
 * duplicate registration throws).
 */

import { toast } from "sonner"
import type { PopoverItem } from "@/components/chat/composer-popover"
import type { SystemPromptPreset, ChatSession } from "@cognia/agent-config-types"
import type { EntitySelectionRef } from "@/types/artifact/artifact"
import type { ContextRef } from "./types"

/** Kinds the registry owns (mention-style picks). */
export type MentionPickKind = Exclude<PopoverItem["kind"], "slash" | "memory">

/** Composer capabilities a handler may use — bound per-pick by the composer. */
export interface MentionPickContext {
  /** Replace the active trigger token with `text` (adds the trailing space). */
  insertReplacement(text: string): void
  /** Remove the active trigger token without inserting anything. */
  removeTriggerToken(): void
  addReferencedPath(ref: { absolute: string; relative: string; isDir: boolean }): void
  toggleEphemeralSkill(skillId: string): void
  addReferencedWorkflowElement(el: {
    type: "node" | "edge"
    id: string
    label: string
    kind: string
  }): void
  applyPreset(preset: SystemPromptPreset, session: ChatSession | null | undefined): Promise<void>
  /**
   * Fetch a remote document (Feishu / Google) and stage it as a composer
   * attachment. Bound by the composer to `useRemoteDocStaging`, which owns the
   * toast lifecycle because the fetch is a network round-trip whose outcome the
   * user has to see.
   */
  stageRemoteDoc(item: Extract<PopoverItem, { kind: "doc" }>): Promise<void>
  /**
   * Read a picked record's body and stage it as a context-selection chip.
   * Bound by the composer to `useEntityMentionStaging`, which owns the toast
   * because the read can come back empty (deleted in another window) and the
   * user has to see that rather than get a silent no-op.
   */
  stageEntity(item: Extract<PopoverItem, { kind: "entity" }>): Promise<EntitySelectionRef | null>
  /**
   * Record a mention that leaves NO token in the message text.
   *
   * `resolve-mentions.ts` recovers mentions by re-parsing the sent text, which
   * by construction can only ever find the insertion-style picks. Every
   * chip-style pick — a remote document staged as an attachment, a record
   * staged as a context chip — was therefore invisible to `metadata.mentions`,
   * including the `doc` kind whose own docblock in `types.ts` claimed the
   * ContextRef was "the ONLY record that the turn cited that document". It was
   * not; nothing wrote one. This is where those refs enter, and the send path
   * merges them with the parsed ones.
   */
  recordMention(ref: ContextRef): void
  session: ChatSession | null | undefined
  clearWorkflowHighlight(): void
  /** Pre-bound i18n string builders (registry code must not hardcode copy). */
  strings: {
    skillEnabled(name: string): string
  }
}

export interface MentionPickHandler<K extends MentionPickKind = MentionPickKind> {
  kind: K
  onPick(item: Extract<PopoverItem, { kind: K }>, ctx: MentionPickContext): void | Promise<void>
  /**
   * May this pick be the VALUE of a `{{parameter}}`? A handle if yes, null if
   * no. Its one consumer is `lib/chat/template/resource-kinds.ts`, which
   * defines the parameter-eligible set as exactly the picks that return one —
   * an equivalence `resource-kinds.test.ts` pins by walking this registry.
   *
   * NOT the same question as "was this cited?". A chip-style pick returns null
   * here (it produces no characters at a sentence position) and still records
   * a citation through {@link MentionPickContext.recordMention}. Conflating the
   * two is what left `doc` with a documented ContextRef that nothing wrote.
   */
  toContextRef(item: Extract<PopoverItem, { kind: K }>): ContextRef | null
}

const handlers = new Map<MentionPickKind, MentionPickHandler>()

export function registerMentionPickHandler<K extends MentionPickKind>(
  handler: MentionPickHandler<K>
): void {
  if (handlers.has(handler.kind)) {
    throw new Error(`mention pick handler for kind "${handler.kind}" already registered`)
  }
  handlers.set(handler.kind, handler as unknown as MentionPickHandler)
}

export function getMentionPickHandler(kind: PopoverItem["kind"]): MentionPickHandler | undefined {
  return handlers.get(kind as MentionPickKind)
}

/**
 * Every registered handler, in registration order.
 *
 * Exists so a rule ABOUT the registry can be checked against the registry
 * itself rather than against a hand-kept list that drifts — see
 * `lib/chat/template/resource-kinds.ts`, whose set of parameter-eligible kinds
 * is defined as "the insertion-style picks" and is pinned by walking this.
 */
export function listMentionPickHandlers(): MentionPickHandler[] {
  return [...handlers.values()]
}

/** Test-only: drop non-built-in registrations (built-ins are re-registered). */
export function __resetMentionPickHandlersForTests(): void {
  handlers.clear()
  registerBuiltinMentionPickHandlers()
}

// ---------------------------------------------------------------------------
// Built-in handlers — behavior ported verbatim from the composer's branches.
// ---------------------------------------------------------------------------

/**
 * `<providerId>:<documentId>`, the id shape `types.ts` documents for `doc`.
 * A ref is only produced once the account is known, because without it the
 * fetch that the ref claims happened could not have run.
 */
function docContextRef(item: Extract<PopoverItem, { kind: "doc" }>): ContextRef | null {
  if (!item.accountId) return null
  return {
    kind: "doc",
    id: `${item.providerId}:${item.doc.id}`,
    label: item.doc.title,
    raw: item.doc.url ?? `@${item.providerId}:${item.doc.id}`,
  }
}

/** `<entityKind>:<recordId>` — one namespace per source, ids unique within it. */
function entityContextRef(item: Extract<PopoverItem, { kind: "entity" }>): ContextRef {
  const { candidate } = item
  return {
    kind: "entity",
    id: `${candidate.entityKind}:${candidate.id}`,
    label: candidate.title,
    raw: `@${candidate.entityKind}:${candidate.id}`,
  }
}

function registerBuiltinMentionPickHandlers(): void {
  registerMentionPickHandler({
    kind: "file",
    onPick: (item, ctx) => {
      const e = item.entry
      ctx.addReferencedPath({ absolute: e.absolutePath, relative: e.relPath, isDir: e.isDir })
      ctx.insertReplacement(`@${e.relPath}${e.isDir ? "/" : ""}`)
    },
    toContextRef: (item) => ({
      kind: "file",
      id: item.entry.relPath,
      raw: `@${item.entry.relPath}${item.entry.isDir ? "/" : ""}`,
    }),
  })

  registerMentionPickHandler({
    kind: "agent",
    onPick: (item, ctx) => {
      ctx.insertReplacement(`@${item.target.name}`)
    },
    toContextRef: (item) => ({
      kind: "agent",
      id: item.target.name,
      raw: `@${item.target.name}`,
    }),
  })

  registerMentionPickHandler({
    kind: "subagent",
    onPick: (item, ctx) => {
      // Insert the unique, no-whitespace handle so the send-time resolver can
      // match it back to the agent id 1:1.
      ctx.insertReplacement(`@${item.target.handle}`)
    },
    toContextRef: (item) => ({
      kind: "subagent",
      id: item.target.handle,
      label: item.target.name,
      raw: `@${item.target.handle}`,
    }),
  })

  registerMentionPickHandler({
    kind: "skill",
    onPick: (item, ctx) => {
      // Picking a skill ENABLES it for the session (renders as a chip); no
      // text is inserted. Drop the `@skill:…` token cleanly.
      ctx.toggleEphemeralSkill(item.skill.id)
      ctx.removeTriggerToken()
      toast.success(ctx.strings.skillEnabled(item.skill.name))
    },
    toContextRef: () => null, // chip-style: session state, not a message mention
  })

  registerMentionPickHandler({
    kind: "preset",
    onPick: async (item, ctx) => {
      // Picking a preset APPLIES it to the session (system prompt + model + …)
      // and removes the `@preset:…` token; `applyPreset` toasts its own
      // success / "start a chat first" guard.
      ctx.removeTriggerToken()
      await ctx.applyPreset(item.preset, ctx.session)
    },
    toContextRef: () => null, // chip-style
  })

  registerMentionPickHandler({
    kind: "doc",
    onPick: async (item, ctx) => {
      // Chip-style: the body is fetched now and staged as an attachment, so no
      // `@…` token survives in the text. Dropping the token FIRST keeps the
      // composer clean even when the fetch then fails — the user gets a toast,
      // not a half-typed `@lark:https://…` to delete by hand.
      ctx.removeTriggerToken()
      await ctx.stageRemoteDoc(item)
      const ref = docContextRef(item)
      if (ref) ctx.recordMention(ref)
    },
    // Still null, and that is not the same statement as "this turn did not
    // cite a document" — `recordMention` above makes that record. This hook
    // answers a narrower question with one consumer: may this pick be a
    // `{{parameter}}` VALUE? A parameter occupies a position in a sentence, and
    // a staged attachment contributes no characters there, so it may not.
    toContextRef: () => null,
  })

  registerMentionPickHandler({
    kind: "entity",
    onPick: async (item, ctx) => {
      // Same order and same reason as `doc`: drop the token first so a read
      // that comes back empty leaves a clean composer, not `@issue:foo`.
      ctx.removeTriggerToken()
      const staged = await ctx.stageEntity(item)
      // Only record what actually got staged. A record deleted between the
      // pick and the read contributes no context, so claiming the turn cited
      // it would make `metadata.mentions` lie in the one direction that
      // matters — asserting context the model never saw.
      if (staged) ctx.recordMention(entityContextRef(item))
    },
    // Chip-style, same as `doc` — see the note there. The citation is carried
    // by `recordMention`, not by this.
    toContextRef: () => null,
  })

  registerMentionPickHandler({
    kind: "wfElement",
    onPick: (item, ctx) => {
      // STAGES the element as a reference chip; expanded to `@node:<id>` /
      // `@edge:<id>` and cited to the agent at send time.
      const el = item.element
      ctx.addReferencedWorkflowElement({ type: el.type, id: el.id, label: el.label, kind: el.kind })
      ctx.removeTriggerToken()
      ctx.clearWorkflowHighlight()
    },
    toContextRef: () => null, // chip-style
  })
}

registerBuiltinMentionPickHandlers()
