"use client"

/**
 * What a prompt slot last resolved to in this window (ADR-0236 §9.2): the
 * evidence of actual use the detail view shows beside the published state.
 */

import { useSyncExternalStore } from "react"
import {
  lastPromptResolution,
  subscribePromptResolutions,
  type PromptResolutionRecord,
} from "@/lib/prompts/resolution-log"

export function useLastPromptResolution(promptId: string): PromptResolutionRecord | undefined {
  return useSyncExternalStore(
    subscribePromptResolutions,
    () => lastPromptResolution(promptId),
    () => undefined
  )
}
