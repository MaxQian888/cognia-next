"use client"

/**
 * Live state of a code slot's overrides (ADR-0236 §5.2), read from the
 * override tables through `useLiveQuery` so a publish from the CLI writer, a
 * second window or an import shows up without a manual refresh.
 */

import { useLiveQuery } from "dexie-react-hooks"
import {
  listPromptOverrideRevisions,
  type PromptOverrideRevisionRow,
} from "@/lib/db/prompt-overrides"
import { listPromptSlots, readPromptSlot, type PromptSlotState } from "@/lib/prompts/service"
import type { PromptTargetRef } from "@/lib/prompts/types"

/** Every scope that holds a binding for the prompt; `undefined` while loading. */
export function usePromptSlots(promptId: string): PromptSlotState[] | undefined {
  return useLiveQuery(() => listPromptSlots(promptId), [promptId])
}

/** One slot and its history; `undefined` while loading. */
export function usePromptSlot(
  promptId: string,
  target: PromptTargetRef
): { slot: PromptSlotState; revisions: PromptOverrideRevisionRow[] } | undefined {
  return useLiveQuery(async () => {
    const slot = await readPromptSlot(promptId, target)
    const revisions = slot.binding ? await listPromptOverrideRevisions(slot.binding.id) : []
    return { slot, revisions }
  }, [promptId, target.scope, target.targetId])
}
