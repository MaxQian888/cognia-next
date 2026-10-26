"use client"

/**
 * The Prompt Center list (ADR-0236 §4): code slots and owner resources from
 * `listPromptResources`, reloaded when an owner it reads from changes. Code
 * slots and the Dexie-backed owners report through the override listener and
 * an explicit `reload()` after the section's own writes; plugin slots through
 * the plugin prompt registry; the store-backed owners (custom modes, the
 * default system prompt) through their stores.
 */

import { useCallback, useEffect, useState } from "react"
import { onPromptOverridesChanged } from "@/lib/db/prompt-overrides"
import { listPromptResources, type PromptResourceListing } from "@/lib/prompts/adapters"
import { onPluginPromptsChanged } from "@/lib/prompts/plugin-prompts"
import type { PromptResourceContext } from "@/lib/prompts/resources"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { useSettingsStore } from "@/stores/settings"

export type PromptResourcesState =
  | { status: "loading"; listing?: PromptResourceListing }
  /** `context` is the one the listing was read for, so a caller can tell it from a stale one. */
  | { status: "ready"; listing: PromptResourceListing; context: PromptResourceContext }
  | { status: "error"; error: string; listing?: PromptResourceListing }

export function usePromptResources(ctx: PromptResourceContext): {
  state: PromptResourcesState
  reload: () => void
} {
  const [epoch, setEpoch] = useState(0)
  const [state, setState] = useState<PromptResourcesState>({ status: "loading" })
  const reload = useCallback(() => setEpoch((value) => value + 1), [])
  const customModes = useCustomModeStore((store) => store.customModes)
  const defaultSystemPrompt = useSettingsStore((store) => store.settings?.defaultSystemPrompt)

  useEffect(() => onPromptOverridesChanged(reload), [reload])
  // A plugin enabled or disabled adds or retires its slots.
  useEffect(() => onPluginPromptsChanged(reload), [reload])

  useEffect(() => {
    let cancelled = false
    listPromptResources(ctx)
      .then((listing) => {
        if (!cancelled) setState({ status: "ready", listing, context: ctx })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState((previous) => ({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          ...(previous.listing ? { listing: previous.listing } : {}),
        }))
      })
    return () => {
      cancelled = true
    }
  }, [ctx, epoch, customModes, defaultSystemPrompt])

  return { state, reload }
}
