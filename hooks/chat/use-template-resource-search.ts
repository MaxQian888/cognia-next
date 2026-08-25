"use client"

// Candidates for a `{{parameter}}` declared as a resource.
//
// Every kind here is answered from the SAME source the `@` menu answers from,
// and every candidate is projected through the same `toContextRef` the `@` pick
// would have used. That is the whole design: there is exactly one definition of
// which files exist, which agents are mentionable, and how each one is spelled
// once it lands in the text. A second, parameter-only picker would have been
// half a menu that drifts — a file that the `@` menu offers and the parameter
// picker doesn't is a bug nobody would think to look for.
//
// Consequently a parameter can only ever be bound to something the user could
// have typed by hand, which is what makes the substituted message resolvable by
// the send path with no extra wiring.

import { useCallback } from "react"

import { searchWorkspace } from "@/lib/files/workspace-search"
import { getMentionPickHandler } from "@/lib/chat/mentions/pick-registry"
import {
  resourceOptionFromRef,
  type ResourceOption,
  type ResourceParamKind,
} from "@/lib/chat/template/resource-kinds"
import type { PopoverItem } from "@/components/chat/composer-popover"
import {
  filterMentionables,
  filterSubagents,
} from "@/components/agent/workspace/agent-mention-picker"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { SubagentMentionTarget } from "@/lib/claude/agents/chat-mention-targets"
import { loggers } from "@cognia/logging"

export interface TemplateResourceSources {
  /** Effective working directory — the root the `file` kind searches. */
  cwd: string | null | undefined
  /** Subagents mentionable in this composer (general chat `@`). */
  chatAgents?: readonly SubagentMentionTarget[]
  /** Team runtime targets (team composer `@`). */
  mentionables?: readonly MentionTarget[]
}

export type TemplateResourceSearch = (
  kind: ResourceParamKind,
  query: string
) => Promise<ResourceOption[]>

/** How many candidates a picker shows. Matches the `@file` menu's own cap. */
const LIMIT = 50

function toOptions(items: readonly PopoverItem[]): ResourceOption[] {
  const out: ResourceOption[] = []
  for (const item of items) {
    const ref = getMentionPickHandler(item.kind)?.toContextRef(
      item as Extract<PopoverItem, { kind: never }>
    )
    const option = ref ? resourceOptionFromRef(ref) : null
    if (option) out.push(option)
  }
  return out
}

export function useTemplateResourceSearch({
  cwd,
  chatAgents,
  mentionables,
}: TemplateResourceSources): TemplateResourceSearch {
  return useCallback(
    async (kind, query) => {
      if (kind === "file") {
        // No workspace means no files — an empty list, not an error. The
        // parameter is still fillable on the next device that has one, and a
        // red panel in a web session would be scolding the user for their shell.
        if (!cwd) return []
        try {
          const entries = await searchWorkspace(cwd, query, LIMIT)
          return toOptions(entries.map((entry) => ({ kind: "file" as const, entry })))
        } catch (err) {
          loggers.chat.warn("template resource file search failed", {
            err: err instanceof Error ? err.message : String(err),
            cwd,
            query,
          })
          return []
        }
      }
      if (kind === "subagent") {
        return toOptions(
          filterSubagents(chatAgents ?? [], query)
            .slice(0, LIMIT)
            .map((target) => ({ kind: "subagent" as const, target }))
        )
      }
      return toOptions(
        filterMentionables(mentionables ?? [], query)
          .slice(0, LIMIT)
          .map((target) => ({ kind: "agent" as const, target }))
      )
    },
    [cwd, chatAgents, mentionables]
  )
}
