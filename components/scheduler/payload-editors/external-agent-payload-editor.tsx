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
import type { ExternalAgentInstance } from "@/types/agent/external-agent"
import { PermissionModeSelect } from "./permission-mode-select"
import type { ExternalAgentDraft } from "./types"

export interface ExternalAgentPayloadEditorProps {
  draft: ExternalAgentDraft
  onDraftChange: (next: ExternalAgentDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string
  agentsForTesting?: Array<{ id: string; name: string }>
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
  const [agents, setAgents] = useState<Array<{ id: string; name: string }> | null>(
    agentsForTesting ?? null
  )

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
          setAgents(all.map((a) => ({ id: a.config.id, name: a.config.name })))
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
            onValueChange={(v) => update("agentId", v === "__none__" ? "" : v)}
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
