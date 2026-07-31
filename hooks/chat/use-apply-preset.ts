"use client"

/**
 * Apply a prompt preset to the active chat session — the `@preset:` mention's
 * pick behavior. A preset is a session-config template (system prompt + model +
 * permission mode + skills + agent mode …), so "applying" it patches the
 * session row and routes the non-row fields to their stores, rather than
 * inserting any text. Mirrors the chat-header config sheet's
 * `applyPresetWithStrategy` but persists immediately (an inline pick is an
 * explicit, unambiguous user action → `overwrite-all`).
 */

import { useCallback } from "react"
import { toast } from "sonner"

import type { ChatSession, SystemPromptPreset } from "@cognia/agent-config-types"
import { buildPresetApplicationPlan } from "@/lib/presets/apply-to-session"
import { useRecordPresetUsage, useUpdateSession } from "@/lib/data-hooks/context"
import { useChatStore } from "@/stores/chat/chat-store"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { useTranslations } from "next-intl"
import { loggers } from "@cognia/logging"

export interface ApplyPresetFn {
  (preset: SystemPromptPreset, session: ChatSession | null | undefined): Promise<boolean>
}

export function useApplyPreset(): ApplyPresetFn {
  const updateSession = useUpdateSession()
  const recordPresetUsage = useRecordPresetUsage()
  const tPreset = useTranslations("chat.composer.presets")

  return useCallback(
    async (preset, session) => {
      if (!session) {
        toast.error(tPreset("needsSession"))
        return false
      }
      const plan = buildPresetApplicationPlan(
        preset,
        {
          systemPrompt: session.systemPrompt,
          model: session.model,
          permissionMode: session.permissionMode,
          workingDir: session.workingDir,
        },
        "overwrite-all"
      )

      // Session-row fields. Exclude permissionMode from the patch — it is
      // mirrored into the chat store and persisted back by the composer's
      // permission-mode effect, so we set it via the store below to avoid the
      // effect reverting a direct row write with the stale store value.
      const { permissionMode, ...rowPatch } = plan.sessionPatch
      await updateSession(session.id, { ...rowPatch, activePresetId: preset.id })

      if (permissionMode !== undefined) {
        useChatStore.getState().setPermissionMode(permissionMode ?? null)
      }

      // Extended (non-row) fields routed to their stores.
      if (plan.extended.skillIds && plan.extended.skillIds.length > 0) {
        const current = useChatStore.getState().ephemeralSkillIds
        const merged = [...new Set([...current, ...plan.extended.skillIds])]
        useChatStore.getState().setEphemeralSkillIds(merged)
      }
      if (plan.extended.agentModeId) {
        useAgentRuntimeStore.getState().setModeId(plan.extended.agentModeId)
      }

      void recordPresetUsage(preset.id).catch((err) => {
        loggers.chat.warn("recordPresetUsage failed", {
          presetId: preset.id,
          err: err instanceof Error ? err.message : String(err),
        })
      })

      toast.success(tPreset("applied", { name: preset.name }))
      return true
    },
    [updateSession, recordPresetUsage, tPreset]
  )
}
