"use client"

/**
 * Reactive source of `@`-mentionable subagents for the general chat composer.
 *
 * `buildChatMentionTargets()` is a snapshot (it reads the template store via
 * `getState()` inside `resolveDispatchableSubagents`), so a component can't just
 * call it and expect to re-render when the user adds / edits / removes a
 * subagent template in Settings. This hook subscribes to the templates slice so
 * the `@` panel stays current; the built-ins and plugin registry are static for
 * a session, so the template slice is the only change signal we need.
 */

import { useMemo } from "react"

import {
  buildChatMentionTargets,
  type SubagentMentionTarget,
} from "@/lib/claude/agents/chat-mention-targets"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

export function useMentionableSubagents(): SubagentMentionTarget[] {
  // Subscribe to the dynamic source so edits re-render the picker.
  const templates = useSubagentRuntimeStore((s) => s.templates)
  // Re-derive only when the templates slice identity changes. The rest of the
  // inputs (plugin registry, host built-ins) are stable for the session.
  return useMemo(() => buildChatMentionTargets(), [templates])
}
