"use client"

/**
 * The two app-level policy panels. They used to be bordered blobs stacked
 * above a tab strip, each with its own Save button and its own
 * `useEffect([settings])` re-hydrate — the pair that let an unrelated save
 * elsewhere silently discard whatever was being typed here.
 *
 * They stay two panels rather than merging into one because
 * `use-setting-focus` resolves `?focus=` against a `[data-setting-id]` anchor:
 * one panel per registered finder control is what keeps that deep link landing
 * on the exact card. `nav-config.ts:panelForFocusId` holds the other half of
 * that contract.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { UnsavedBar } from "@/components/settings/common/unsaved-bar"

import { usePolicyDraft } from "../use-policy-draft"
import { useReportPanelDirty } from "../panel-dirty-context"
import {
  SubagentNestingCard,
  nestingValuesFromSettings,
  nestingValuesToSettings,
} from "../subagent-nesting-card"
import {
  BackgroundTasksCard,
  backgroundValuesFromSettings,
  backgroundValuesToSettings,
} from "../background-tasks-card"

/** Shared chrome: heading, body, and the bar pinned to the foot of the pane. */
function PolicyShell({
  title,
  description,
  status,
  count,
  onSave,
  onDiscard,
  children,
}: {
  title: string
  description: string
  status: React.ComponentProps<typeof UnsavedBar>["status"]
  count: number
  onSave: () => void
  onDiscard: () => void
  children: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
      <div className="sticky bottom-0 z-10 pt-2">
        <UnsavedBar status={status} count={count} onSave={onSave} onDiscard={onDiscard} />
      </div>
    </div>
  )
}

export function NestingPanel() {
  const t = useTranslations("settings.subagents.nesting")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  // Reference changes with every settings write; `usePolicyDraft` only reads
  // it when the identity ("nesting") changes, which is what protects the draft.
  const initial = useMemo(() => nestingValuesFromSettings(settings), [settings])
  const persist = useCallback(
    async (values: typeof initial) => {
      await save({ subagentNesting: nestingValuesToSettings(values) })
    },
    [save]
  )

  const policy = usePolicyDraft("nesting", initial, persist)
  useReportPanelDirty(policy.isDirty)

  return (
    <PolicyShell
      title={t("title")}
      description={t("description")}
      status={policy.status}
      count={policy.dirtyCount}
      onSave={policy.save}
      onDiscard={policy.discard}
    >
      <SubagentNestingCard value={policy.draft} onChange={policy.patch} />
    </PolicyShell>
  )
}

export function BackgroundPanel() {
  const t = useTranslations("settings.subagents.backgroundTasks")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const initial = useMemo(() => backgroundValuesFromSettings(settings), [settings])
  // `agentPermissions` is read at save time, not captured in the draft: this
  // card owns three of its keys and must not stomp the siblings it does not.
  const persist = useCallback(
    async (values: typeof initial) => {
      const current = useSettingsStore.getState().settings?.agentPermissions
      await save(backgroundValuesToSettings(values, current))
    },
    [save]
  )

  const policy = usePolicyDraft("background", initial, persist)
  useReportPanelDirty(policy.isDirty)

  return (
    <PolicyShell
      title={t("title")}
      description={t("description")}
      status={policy.status}
      count={policy.dirtyCount}
      onSave={policy.save}
      onDiscard={policy.discard}
    >
      <BackgroundTasksCard value={policy.draft} onChange={policy.patch} />
    </PolicyShell>
  )
}
