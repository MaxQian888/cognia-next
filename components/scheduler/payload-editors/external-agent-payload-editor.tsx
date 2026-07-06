"use client"

/**
 * Structured payload editor for `external-agent` tasks. Drives an ACP agent
 * (Claude Desktop, Cursor, Codex, Gemini, …) via
 * `lib/ai/agent/external/manager:executeOnExternalAgent`.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { adaptPermissionMode } from "@/lib/ai/agent/external/permission-modes"
import type { ExternalAgentInstance, ExternalAgentProtocol } from "@/types/agent/external-agent"
import { PermissionModeSelect } from "./permission-mode-select"
import type { ExternalAgentDraft } from "./types"

interface PayloadAgentOption {
  id: string
  name: string
  protocol?: ExternalAgentProtocol
}

export interface ExternalAgentPayloadEditorProps {
  draft: ExternalAgentDraft
  onDraftChange: (next: ExternalAgentDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string
  agentsForTesting?: PayloadAgentOption[]
}

export function ExternalAgentPayloadEditor({
  draft,
  onDraftChange,
  errors,
  disabled,
  testId = "external-agent-payload-editor",
  agentsForTesting,
}: ExternalAgentPayloadEditorProps) {
  const t = useTranslations("scheduler")
  const [agents, setAgents] = useState<PayloadAgentOption[] | null>(agentsForTesting ?? null)

  useEffect(() => {
    if (agentsForTesting) return
    // Defer the setState onto a microtask so the rule against calling setState
    // synchronously inside an effect body is satisfied — manager.getAllAgents()
    // is synchronous so a Promise trampoline is the cheapest option.
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (cancelled) return
        try {
          const manager = getExternalAgentManager()
          const all: ExternalAgentInstance[] = manager.getAllAgents()
          setAgents(
            all.map((a) => ({
              id: a.config.id,
              name: a.config.name,
              protocol: a.config.protocol,
            }))
          )
        } catch {
          // Manager not initialized yet — surface empty list and let user type id directly.
          setAgents([])
        }
      })
      .catch(() => {
        if (!cancelled) setAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [agentsForTesting])

  function update<K extends keyof ExternalAgentDraft>(key: K, value: ExternalAgentDraft[K]) {
    onDraftChange({ ...draft, [key]: value })
  }

  const hasAgents = (agents?.length ?? 0) > 0
  const selectedProtocol = agents?.find((a) => a.id === draft.agentId)?.protocol

  /**
   * Switch the target agent and, if the current permission mode cannot be
   * enforced by the new backend, clamp it to the nearest supported mode in the
   * same update so the saved draft never carries a backend-incompatible value.
   */
  function selectAgent(agentId: string) {
    const nextProtocol = agents?.find((a) => a.id === agentId)?.protocol
    const next: ExternalAgentDraft = { ...draft, agentId }
    if (draft.permissionMode && nextProtocol) {
      next.permissionMode = adaptPermissionMode(draft.permissionMode, nextProtocol)
        .mode as ExternalAgentDraft["permissionMode"]
    }
    onDraftChange(next)
  }

  return (
    <div className="space-y-4" data-testid={testId}>
      {/* Prompt */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.prompt")} <span className="text-destructive">*</span>
        </Label>
        <Textarea
          value={draft.prompt}
          onChange={(e) => update("prompt", e.target.value)}
          rows={4}
          placeholder={t("payload.promptPlaceholder")}
          disabled={disabled}
          className={cn(errors?.prompt && "border-destructive focus-visible:ring-destructive/20")}
          data-testid={`${testId}-prompt-input`}
        />
        {errors?.prompt && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.prompt}`)}</p>
        )}
      </div>

      {/* Agent picker — falls back to free-text when no instance is configured */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.externalAgent.agentId")} <span className="text-destructive">*</span>
        </Label>
        {hasAgents ? (
          <Select
            value={draft.agentId || "__none__"}
            onValueChange={(v) => selectAgent(v === "__none__" ? "" : v)}
            disabled={disabled}
          >
            <SelectTrigger
              className={cn("h-10", errors?.agentId && "border-destructive")}
              data-testid={`${testId}-agent-select`}
            >
              <SelectValue placeholder={t("payload.externalAgent.agentIdPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">
                {t("payload.externalAgent.agentIdPlaceholder")}
              </SelectItem>
              {(agents ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} <span className="text-xs text-muted-foreground font-mono">({a.id})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={draft.agentId}
            onChange={(e) => update("agentId", e.target.value)}
            placeholder={t("payload.externalAgent.agentIdPlaceholder")}
            disabled={disabled}
            className={cn("h-10 font-mono text-sm", errors?.agentId && "border-destructive")}
            data-testid={`${testId}-agent-input`}
          />
        )}
        {errors?.agentId && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.agentId}`)}</p>
        )}
        {!hasAgents && (
          <p className="text-xs text-muted-foreground">{t("payload.externalAgent.noAgentsHelp")}</p>
        )}
      </div>

      {/* Permission mode */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.permissionMode")}</Label>
        <PermissionModeSelect
          flavor="acp"
          protocol={selectedProtocol}
          value={draft.permissionMode}
          onChange={(v) =>
            update("permissionMode", (v as ExternalAgentDraft["permissionMode"]) ?? undefined)
          }
          disabled={disabled}
          testId={`${testId}-permission-mode`}
        />
      </div>

      {/* CWD + timeout */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.externalAgent.cwd")}</Label>
          <Input
            value={draft.cwd ?? ""}
            onChange={(e) => update("cwd", e.target.value || undefined)}
            placeholder={t("payload.externalAgent.cwdPlaceholder")}
            disabled={disabled}
            className="h-10 font-mono text-xs"
            data-testid={`${testId}-cwd-input`}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.externalAgent.timeoutMs")}</Label>
          <Input
            type="number"
            min={1000}
            value={draft.timeoutMs ?? ""}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              update("timeoutMs", Number.isFinite(n) && n > 0 ? n : undefined)
            }}
            placeholder={t("payload.externalAgent.timeoutMsPlaceholder")}
            disabled={disabled}
            className="h-10"
            data-testid={`${testId}-timeout-input`}
          />
        </div>
      </div>
    </div>
  )
}
