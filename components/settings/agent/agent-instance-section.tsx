"use client"

/**
 * One configuration among the others of its runtime (ADR-0216).
 *
 * The inspector's answer to "how is this one different, and what does it
 * share?":
 *
 *   - where its runtime state lives (its own folder, or the runtime's shared
 *     one), and for its own folder, the path and size on this machine;
 *   - how many sessions it keeps open;
 *   - the other configurations of the same runtime, each with what differs;
 *   - which of them share its login, settings and history right now.
 *
 * Isolation and the session limit are draft fields: the inspector owns the
 * draft and its one save bar, so every inline edit is saved the same way.
 */

import { useEffect, useId, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, FolderOpenIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { BrandIcon } from "@/components/icons/brand-icon"
import { StateIsolationField } from "@/components/agent/external-agent/add-agent/state-isolation-field"
import {
  InstanceTraitChips,
  StateIsolationBadge,
} from "@/components/agent/external-agent/instance-traits"
import {
  instanceDifferences,
  runtimeSiblings,
  sharedStateSiblings,
} from "@/lib/ai/agent/external/config/instance-family"
import { isFromPreset } from "@/lib/ai/agent/external/config/presets"
import {
  getExternalAgentStateRootInfo,
  type ExternalAgentStateRootInfo,
} from "@/lib/ai/agent/external/lifecycle/state-root"
import { revealItemInDir } from "@/lib/native/opener"
import { formatBytes } from "@/lib/storage/usage"
import { isTauri } from "@/lib/tauri"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import type { ExternalAgentStateIsolation } from "@/types/agent/external-agent"

type StateFolder =
  | { status: "loading" }
  | { status: "ready"; info: ExternalAgentStateRootInfo | null }
  | { status: "error"; message: string }

/** Path and size of an isolated configuration's own folder on this machine. */
function StateFolderRow({ agentId }: { agentId: string }) {
  const t = useTranslations("externalAgent.instanceSection")
  const [folder, setFolder] = useState<StateFolder>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    getExternalAgentStateRootInfo(agentId).then(
      (info) => {
        if (!cancelled) setFolder({ status: "ready", info })
      },
      (error: unknown) => {
        if (!cancelled) {
          setFolder({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [agentId])

  if (folder.status === "loading") {
    return (
      <p
        className="text-xs text-muted-foreground"
        aria-busy="true"
        data-testid="state-folder-loading"
      >
        {t("folderLoading")}
      </p>
    )
  }
  if (folder.status === "error") {
    return (
      <p className="text-xs text-destructive" role="alert" data-testid="state-folder-error">
        {t("folderError", { message: folder.message })}
      </p>
    )
  }
  if (!folder.info) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="state-folder-remote">
        {t("folderElsewhere")}
      </p>
    )
  }
  const { info } = folder
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="state-folder">
      <code
        className="min-w-0 flex-1 basis-48 truncate rounded bg-muted px-1.5 py-0.5 text-xs"
        title={info.path}
      >
        {info.path}
      </code>
      <span className="text-xs text-muted-foreground tabular-nums">
        {info.exists ? formatBytes(info.bytes) : t("folderNotCreated")}
      </span>
      {isTauri() && info.exists ? (
        <Button
          variant="outline"
          size="sm"
          className="touch-hit h-7 gap-1 px-2 text-xs"
          onClick={() => void revealItemInDir(info.path)}
          data-testid="state-folder-reveal"
        >
          <FolderOpenIcon className="size-3.5" aria-hidden />
          {t("folderReveal")}
        </Button>
      ) : null}
    </div>
  )
}

export function AgentInstanceSection({
  agent,
  allAgents,
  draftIsolation,
  onDraftIsolationChange,
  draftSessionLimit,
  onDraftSessionLimitChange,
  onOpenAgent,
}: {
  agent: LifecycleExternalAgentConfig
  allAgents: readonly LifecycleExternalAgentConfig[]
  draftIsolation: ExternalAgentStateIsolation
  onDraftIsolationChange: (value: ExternalAgentStateIsolation) => void
  /** The limit as typed; empty means unlimited. */
  draftSessionLimit: string
  onDraftSessionLimitChange: (value: string) => void
  onOpenAgent: (agentId: string) => void
}) {
  const t = useTranslations("externalAgent.instanceSection")
  const limitId = useId()
  const local = agent.transport === "stdio"
  const siblings = runtimeSiblings(agent, allAgents)
  const sharing = sharedStateSiblings(agent, allAgents)

  return (
    <section
      className="space-y-4 rounded-lg border p-3"
      aria-labelledby={`${limitId}-title`}
      data-testid="agent-instance-section"
    >
      <div>
        <h4 id={`${limitId}-title`} className="text-sm font-medium">
          {t("title")}
        </h4>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {local ? (
        <div className="space-y-2">
          <StateIsolationField
            value={draftIsolation}
            onChange={onDraftIsolationChange}
            command={agent.process?.command}
            args={agent.process?.args ?? []}
            showSignInWarning={agent.stateIsolation !== "isolated"}
          />
          {agent.stateIsolation === "isolated" ? <StateFolderRow agentId={agent.id} /> : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="instance-state-remote">
          {t("remoteState")}
        </p>
      )}

      {sharing.length > 0 ? (
        <p
          className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="instance-shared-state-warning"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("sharedWith", {
            count: sharing.length,
            names: sharing.map((other) => other.name).join(", "),
          })}
        </p>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor={limitId}>{t("sessionLimit")}</Label>
        <Input
          id={limitId}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={draftSessionLimit}
          placeholder={t("sessionLimitUnlimited")}
          onChange={(event) => onDraftSessionLimitChange(event.target.value)}
          aria-describedby={`${limitId}-hint`}
          className="max-w-40"
          data-testid="instance-session-limit"
        />
        <p id={`${limitId}-hint`} className="text-xs text-muted-foreground">
          {t("sessionLimitHint")}
        </p>
      </div>

      {siblings.length > 0 ? (
        <div className="space-y-2" data-testid="instance-siblings">
          <p className="text-xs font-medium text-muted-foreground">
            {t("siblings", { count: siblings.length })}
          </p>
          <ul className="space-y-1">
            {siblings.map((sibling) => {
              const differences = instanceDifferences(sibling, agent).map((difference) => ({
                key: difference.key,
                value: difference.value,
              }))
              return (
                <li key={sibling.id}>
                  <button
                    type="button"
                    onClick={() => onOpenAgent(sibling.id)}
                    className="touch-hit flex w-full min-w-0 items-start gap-2 rounded-md border px-2 py-1.5 text-left hover:bg-accent/50"
                    data-testid={`instance-sibling-${sibling.id}`}
                  >
                    <BrandIcon
                      id={isFromPreset(sibling) ?? sibling.name}
                      label={sibling.name}
                      size={18}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm">{sibling.name}</span>
                        <StateIsolationBadge config={sibling} className="h-4 px-1 text-[10px]" />
                      </span>
                      {differences.length > 0 ? (
                        <InstanceTraitChips traits={differences} max={4} className="mt-0.5" />
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("siblingSame")}</span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
