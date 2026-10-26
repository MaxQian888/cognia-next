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

import { useEffect, useId, useState, type Ref } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "@/components/ui/sonner"
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
import { findRuntimeForConfig } from "@/lib/ai/agent/external/config/install-catalog"
import {
  getExternalAgentStateRootInfo,
  type ExternalAgentStateRootInfo,
} from "@/lib/ai/agent/external/lifecycle/state-root"
import { revealItemInDir } from "@/lib/native/opener"
import { formatBytes } from "@/lib/storage/usage"
import { isTauri } from "@/lib/tauri"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { cn } from "@/lib/utils"
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
    <div
      role="group"
      aria-label={t("folderLabel")}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3"
      data-testid="state-folder"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium">
            <FolderIcon className="size-3.5 text-muted-foreground" aria-hidden />
            {t("folderLabel")}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {info.exists ? formatBytes(info.bytes) : t("folderNotCreated")}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="touch-hit size-7 text-muted-foreground"
            aria-label={t("folderCopy")}
            title={t("folderCopy")}
            onClick={async () => {
              try {
                await writeClipboardText(info.path)
                toast.success(t("folderCopied"))
              } catch {
                toast.error(t("folderCopyFailed"))
              }
            }}
          >
            <CopyIcon className="size-3.5" aria-hidden />
          </Button>
          {isTauri() && info.exists ? (
            <Button
              variant="ghost"
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
      </div>
      <code className="min-w-0 select-all break-all text-xs leading-5 text-muted-foreground">
        {info.path}
      </code>
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
  sessionLimitRef,
}: {
  agent: LifecycleExternalAgentConfig
  allAgents: readonly LifecycleExternalAgentConfig[]
  draftIsolation: ExternalAgentStateIsolation
  onDraftIsolationChange: (value: ExternalAgentStateIsolation) => void
  /** The limit as typed; empty means unlimited. */
  draftSessionLimit: string
  onDraftSessionLimitChange: (value: string) => void
  onOpenAgent: (agentId: string) => void
  sessionLimitRef?: Ref<HTMLInputElement>
}) {
  const t = useTranslations("externalAgent.instanceSection")
  const limitId = useId()
  const local = agent.transport === "stdio"
  const siblings = runtimeSiblings(agent, allAgents)
  const sharing = sharedStateSiblings(agent, allAgents)

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      headingLevel={4}
      testid="agent-instance-section"
    >
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
          className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="instance-shared-state-warning"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("sharedWith", {
            count: sharing.length,
            names: sharing.map((other) => other.name).join(", "),
          })}
        </p>
      ) : null}

      <div className="@container/instance-options">
        <div
          className={cn("grid gap-5", siblings.length > 0 && "@xl/instance-options:grid-cols-2")}
        >
          <div className="grid content-start gap-2">
            <Label htmlFor={limitId}>{t("sessionLimit")}</Label>
            <Input
              ref={sessionLimitRef}
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
            <div
              className="min-w-0 border-t border-border/60 pt-4 @xl/instance-options:border-t-0 @xl/instance-options:border-l @xl/instance-options:pt-0 @xl/instance-options:pl-5"
              data-testid="instance-siblings"
            >
              <p className="mb-2 text-sm font-medium">
                {t("siblings", { count: siblings.length })}
              </p>
              <ul className="divide-y divide-border/60">
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
                        className="touch-hit flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`instance-sibling-${sibling.id}`}
                      >
                        <BrandIcon
                          id={
                            isFromPreset(sibling) ??
                            findRuntimeForConfig(sibling)?.runtimeId ??
                            sibling.name
                          }
                          label={sibling.name}
                          size={18}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="break-all text-sm">{sibling.name}</span>
                            <StateIsolationBadge
                              config={sibling}
                              className="h-4 px-1 text-[10px]"
                            />
                          </span>
                          {differences.length > 0 ? (
                            <InstanceTraitChips traits={differences} max={4} className="mt-0.5" />
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {t("siblingSame")}
                            </span>
                          )}
                        </span>
                        <ChevronRightIcon
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </SettingsBlock>
  )
}
