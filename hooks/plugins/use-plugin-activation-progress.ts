"use client"

/**
 * Per-plugin view of activation progress, localized.
 *
 * Selector-scoped on purpose: subscribing to the whole `byPluginId` map would
 * re-render every plugin row on every phase boundary of every activation, which
 * on a cold start means dozens of rows churning seven times each.
 */

import { useTranslations } from "next-intl"

import {
  PLUGIN_ACTIVATION_TOTAL,
  type PluginActivationProgress,
} from "@/lib/plugin/core/activation-phases"
import { usePluginActivationProgressStore } from "@/stores/plugin-runtime/plugin-activation-progress-store"

export interface PluginActivationProgressView {
  progress: PluginActivationProgress | null
  /** Still running — the only state that should show a bar. */
  active: boolean
  /** Reached a terminal state (completed / failed / cancelled). */
  terminal: boolean
  percent: number
  /** Localized phase text, e.g. "Starting the plugin". */
  phaseLabel: string
  /** Localized "Step 4 of 7". */
  countLabel: string
}

export function usePluginActivationProgress(pluginId: string): PluginActivationProgressView {
  const progress = usePluginActivationProgressStore((state) => state.byPluginId[pluginId])
  const t = useTranslations("plugins.activation")

  if (!progress) {
    return {
      progress: null,
      active: false,
      terminal: false,
      percent: 0,
      phaseLabel: "",
      countLabel: "",
    }
  }

  const total = progress.total || PLUGIN_ACTIVATION_TOTAL
  return {
    progress,
    active: progress.status === "running",
    terminal: progress.status !== "running",
    percent: Math.min(100, Math.max(0, Math.round((progress.processed / total) * 100))),
    phaseLabel: t(`phase.${progress.phase}`),
    countLabel: t("countLabel", { processed: progress.processed, total }),
  }
}
