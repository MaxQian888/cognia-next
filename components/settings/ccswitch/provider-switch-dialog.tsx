"use client"

// Preview + confirm dialog for a CCSwitch provider switch. Shows the user
// the full SwitchPlan (cognia-next changes + per-agent env block patches)
// before anything is written. Confirming runs `applySwitch` and surfaces
// per-agent success/failure rather than aborting on the first error.

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"

import { applySwitch, planSwitch } from "@/lib/ccswitch/switch"
import type { ApplyResult } from "@/lib/ccswitch/switch"
import type { CcswitchProvider, SwitchPlan } from "@/lib/ccswitch/types"
import type { AgentId } from "@/lib/claude/types"
import { getSettings } from "@/lib/db/settings"

const PROPAGATABLE_AGENTS: ReadonlyArray<{
  id: AgentId
  labelKey: string
}> = [
  { id: "claude-code", labelKey: "claude-code" },
  // Other agents are listed in the UI but flagged unsupported in the plan;
  // adding them here lets the user see the option.
  { id: "codex", labelKey: "codex" },
  { id: "claude-desktop", labelKey: "claude-desktop" },
  { id: "gemini", labelKey: "gemini" },
]

export interface ProviderSwitchDialogProps {
  provider: CcswitchProvider | null
  /** Initial agent selection (e.g., from `ccswitchSync.defaultPropagation`). */
  initialAgents?: AgentId[]
  open: boolean
  onOpenChange: (next: boolean) => void
  onApplied?: (result: ApplyResult) => void
}

export function ProviderSwitchDialog({
  provider,
  initialAgents = [],
  open,
  onOpenChange,
  onApplied,
}: ProviderSwitchDialogProps) {
  const t = useTranslations("ccswitch")

  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>([])
  const [plan, setPlan] = useState<SwitchPlan | null>(null)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)

  // Capture the latest `initialAgents` in a ref so the open-effect below can
  // read it without depending on its reference. Default-array props would
  // otherwise produce a new reference every render and cause an infinite
  // re-init loop.
  const initialAgentsRef = useRef(initialAgents)
  useEffect(() => {
    initialAgentsRef.current = initialAgents
  })

  // Reset state every time the dialog opens for a new provider.
  useEffect(() => {
    if (open) {
      setSelectedAgents(initialAgentsRef.current)
      setResult(null)
    }
  }, [open, provider?.id])

  // Re-plan whenever the user changes the agent selection.
  useEffect(() => {
    if (!open || !provider) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the plan when the dialog closes
      setPlan(null)
      return
    }
    let cancelled = false
    void getSettings().then((s) => {
      if (cancelled) return
      const next = planSwitch(
        provider,
        { cognia: true, agents: selectedAgents },
        {
          apiKey: s.apiKey,
          apiBaseUrl: s.apiBaseUrl,
          activeProviderId: s.activeProviderId,
        }
      )
      setPlan(next)
    })
    return () => {
      cancelled = true
    }
  }, [open, provider, selectedAgents])

  const supportedSelection = useMemo(
    () => plan?.agentChanges.filter((a) => !a.unsupported).length ?? 0,
    [plan]
  )

  const toggleAgent = (id: AgentId, checked: boolean) => {
    setSelectedAgents((prev) => (checked ? [...prev, id] : prev.filter((a) => a !== id)))
  }

  const onConfirm = async () => {
    if (!plan) return
    setApplying(true)
    try {
      const r = await applySwitch(plan)
      setResult(r)
      onApplied?.(r)
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("dialog.title")}</DialogTitle>
          <DialogDescription>
            {provider ? t("dialog.bodyFor", { name: provider.name }) : t("dialog.body")}
          </DialogDescription>
        </DialogHeader>

        {provider && plan && (
          <div className="space-y-4 text-sm">
            {/* Cognia-next changes */}
            <section className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("dialog.cogniaSection")}
              </h4>
              <div className="rounded border bg-muted/30 px-3 py-2 space-y-1">
                <DiffRow
                  label={t("dialog.apiKey")}
                  before={plan.cogniaChanges.apiKeyBefore}
                  after={plan.cogniaChanges.apiKeyAfter}
                  redact
                />
                <DiffRow
                  label={t("dialog.baseUrl")}
                  before={plan.cogniaChanges.baseUrlBefore}
                  after={plan.cogniaChanges.baseUrlAfter}
                />
                <div className="text-[11px] text-muted-foreground">
                  {plan.cogniaChanges.restartSidecar
                    ? t("dialog.willRestart")
                    : t("dialog.noChange")}
                </div>
              </div>
            </section>

            <Separator />

            {/* Agent picker */}
            <section className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("dialog.agentsSection")}
              </h4>
              <div className="space-y-1">
                {PROPAGATABLE_AGENTS.map((a) => {
                  const checked = selectedAgents.includes(a.id)
                  const patch = plan.agentChanges.find((p) => p.agentId === a.id)
                  const unsupported = patch?.unsupported ?? false
                  return (
                    <label
                      key={a.id}
                      className="flex items-start gap-2 px-2 py-1 rounded hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggleAgent(a.id, v === true)}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{t(`agents.${a.labelKey}`)}</span>
                          {unsupported && checked && (
                            <Badge variant="outline" className="text-[10px]">
                              {t("dialog.notYetSupported")}
                            </Badge>
                          )}
                        </div>
                        {patch && !patch.unsupported && checked && patch.targetPath && (
                          <div className="text-[11px] text-muted-foreground font-mono break-all">
                            {patch.targetPath}
                          </div>
                        )}
                      </div>
                    </label>
                  )
                })}
              </div>
              {supportedSelection > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t("dialog.willWrite", { count: supportedSelection })}
                </p>
              )}
            </section>

            {result && <ApplyResultPanel result={result} />}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            {result ? t("dialog.close") : t("dialog.cancel")}
          </Button>
          {!result && (
            <Button onClick={onConfirm} disabled={!plan || applying}>
              {applying && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              {t("dialog.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DiffRow({
  label,
  before,
  after,
  redact,
}: {
  label: string
  before?: string
  after?: string
  redact?: boolean
}) {
  const present = (v: string | undefined) => (v ? (redact ? maskKey(v) : v) : "—")
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono break-all">
        <span className="text-muted-foreground line-through">{present(before)}</span>
        <span className="mx-1 text-muted-foreground">→</span>
        <span>{present(after)}</span>
      </div>
    </div>
  )
}

function maskKey(v: string): string {
  if (v.length <= 8) return "•".repeat(v.length)
  return `${v.slice(0, 4)}…${v.slice(-4)}`
}

function ApplyResultPanel({ result }: { result: ApplyResult }) {
  const t = useTranslations("ccswitch")
  return (
    <section className="space-y-2 rounded border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        {result.cogniaApplied ? (
          <CheckCircle2Icon className="size-4 text-green-600" />
        ) : (
          <XCircleIcon className="size-4 text-destructive" />
        )}
        <span>{t("dialog.cogniaApplied")}</span>
      </div>
      {result.agentResults.length > 0 && (
        <ul className="space-y-1 text-xs">
          {result.agentResults.map((r) => (
            <li key={r.agentId} className="flex items-start gap-2">
              {r.ok ? (
                <CheckCircle2Icon className="size-4 mt-px text-green-600 shrink-0" />
              ) : (
                <AlertTriangleIcon className="size-4 mt-px text-amber-600 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.agentId}</div>
                {r.path && (
                  <div className="font-mono text-[11px] text-muted-foreground break-all">
                    {r.path}
                  </div>
                )}
                {r.error && <div className="text-[11px] text-destructive break-all">{r.error}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
