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
   * Structured handle for insertion-style picks; null for chip-style picks
   * (session-state mutations are not message mentions).
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
    },
    // Staged as an attachment, not an inline token: the attachment manifest
    // already carries the provenance, so there is no message mention to persist.
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
