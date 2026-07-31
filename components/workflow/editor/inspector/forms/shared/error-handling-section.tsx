"use client"

/**
 * Per-node "Error handling" inspector section (n8n/Dify parity). Edits
 * `WorkflowNode.data.errorHandling` — onError mode (fail / continue /
 * errorBranch / defaultValue), an optional retry override, and the static
 * default value (validated JSON). Rendered only for kinds passing
 * `supportsErrorHandling`; an all-defaults state stores `undefined` so
 * legacy nodes stay byte-identical.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ShieldAlertIcon } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { WorkflowNodeErrorHandling } from "@/types/workflow/visual"
import { Field } from "../shared"

export interface ErrorHandlingSectionProps {
  errorHandling: WorkflowNodeErrorHandling | undefined
  onChange: (next: WorkflowNodeErrorHandling | undefined) => void
}

/** Drop empty objects so an all-defaults config persists as `undefined`. */
function normalize(next: WorkflowNodeErrorHandling): WorkflowNodeErrorHandling | undefined {
  const out: WorkflowNodeErrorHandling = {}
  if (next.retry) out.retry = next.retry
  if (next.onError && next.onError !== "fail") out.onError = next.onError
  if (next.onError === "defaultValue" && next.defaultValue !== undefined) {
    out.defaultValue = next.defaultValue
  }
  if (next.circuitBreaker) out.circuitBreaker = next.circuitBreaker
  return Object.keys(out).length > 0 ? out : undefined
}

export function ErrorHandlingSection({ errorHandling, onChange }: ErrorHandlingSectionProps) {
  const t = useTranslations("workflows.editor.errorHandling")
  const [open, setOpen] = useState(Boolean(errorHandling))
  const [defaultValueText, setDefaultValueText] = useState(() =>
    errorHandling?.defaultValue !== undefined
      ? JSON.stringify(errorHandling.defaultValue, null, 2)
      : ""
  )
  const [jsonError, setJsonError] = useState(false)

  const onError = errorHandling?.onError ?? "fail"
  const retry = errorHandling?.retry
  const breaker = errorHandling?.circuitBreaker

  const patch = (partial: Partial<WorkflowNodeErrorHandling>) => {
    onChange(normalize({ ...errorHandling, ...partial }))
  }

  const handleDefaultValueChange = (text: string) => {
    setDefaultValueText(text)
    if (!text.trim()) {
      setJsonError(false)
      patch({ defaultValue: undefined })
      return
    }
    try {
      const parsed = JSON.parse(text) as unknown
      setJsonError(false)
      patch({ defaultValue: parsed })
    } catch {
      // Keep the draft text editable; only commit valid JSON.
      setJsonError(true)
    }
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border bg-muted/30"
      data-testid="error-handling-section"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ShieldAlertIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 text-sm font-medium">{t("title")}</span>
        {errorHandling ? (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            {t("configuredBadge")}
          </span>
        ) : null}
        <ChevronDownIcon
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-3 pb-3">
        <Field label={t("onError.label")} htmlFor="eh-onerror" hint={t("onError.hint")}>
          <Select
            value={onError}
            onValueChange={(v) =>
              patch({ onError: v as NonNullable<WorkflowNodeErrorHandling["onError"]> })
            }
          >
            <SelectTrigger id="eh-onerror">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fail">{t("onError.fail")}</SelectItem>
              <SelectItem value="continue">{t("onError.continue")}</SelectItem>
              <SelectItem value="errorBranch">{t("onError.errorBranch")}</SelectItem>
              <SelectItem value="defaultValue">{t("onError.defaultValue")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {onError === "errorBranch" ? (
          <p className="text-[11px] text-muted-foreground">{t("errorBranchHint")}</p>
        ) : null}

        {onError === "defaultValue" ? (
          <Field label={t("defaultValue.label")} htmlFor="eh-default" hint={t("defaultValue.hint")}>
            <Textarea
              id="eh-default"
              value={defaultValueText}
              onChange={(e) => handleDefaultValueChange(e.target.value)}
              rows={4}
              className={cn("font-mono text-xs", jsonError && "border-destructive")}
              placeholder='{ "completion": "fallback" }'
            />
            {jsonError ? (
              <p className="text-[11px] text-destructive" data-testid="eh-json-error">
                {t("defaultValue.invalidJson")}
              </p>
            ) : null}
          </Field>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm">{t("retry.toggle")}</p>
            <p className="text-[11px] text-muted-foreground">{t("retry.toggleHint")}</p>
          </div>
          <Switch
            checked={Boolean(retry)}
            onCheckedChange={(v) =>
              patch({
                retry: v
                  ? { maxRetries: 0, retryIntervalMs: 1000, backoff: "exponential" }
                  : undefined,
              })
            }
            aria-label={t("retry.toggle")}
          />
        </div>

        {retry ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("retry.maxRetries")} htmlFor="eh-retries" hint={t("retry.maxHint")}>
              <Input
                id="eh-retries"
                type="number"
                min={0}
                max={20}
                value={retry.maxRetries}
                onChange={(e) =>
                  patch({
                    retry: { ...retry, maxRetries: Math.max(0, Number(e.target.value) || 0) },
                  })
                }
              />
            </Field>
            <Field label={t("retry.intervalMs")} htmlFor="eh-interval">
              <Input
                id="eh-interval"
                type="number"
                min={0}
                step={100}
                value={retry.retryIntervalMs}
                onChange={(e) =>
                  patch({
                    retry: { ...retry, retryIntervalMs: Math.max(0, Number(e.target.value) || 0) },
                  })
                }
              />
            </Field>
            <Field label={t("retry.backoff")} htmlFor="eh-backoff">
              <Select
                value={retry.backoff}
                onValueChange={(v) =>
                  patch({ retry: { ...retry, backoff: v as "fixed" | "exponential" } })
                }
              >
                <SelectTrigger id="eh-backoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">{t("retry.fixed")}</SelectItem>
                  <SelectItem value="exponential">{t("retry.exponential")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {retry.backoff === "exponential" ? (
              <Field label={t("retry.maxIntervalMs")} htmlFor="eh-maxinterval">
                <Input
                  id="eh-maxinterval"
                  type="number"
                  min={0}
                  step={1000}
                  value={retry.maxIntervalMs ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value
                    patch({
                      retry: {
                        ...retry,
                        maxIntervalMs: raw === "" ? undefined : Math.max(0, Number(raw) || 0),
                      },
                    })
                  }}
                />
              </Field>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <div>
            <p className="text-sm">{t("circuitBreaker.toggle")}</p>
            <p className="text-[11px] text-muted-foreground">{t("circuitBreaker.toggleHint")}</p>
          </div>
          <Switch
            checked={Boolean(breaker)}
            onCheckedChange={(v) =>
              patch({ circuitBreaker: v ? { threshold: 5, cooldownMs: 60_000 } : undefined })
            }
            aria-label={t("circuitBreaker.toggle")}
          />
        </div>

        {breaker ? (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t("circuitBreaker.threshold")}
              htmlFor="eh-cb-threshold"
              hint={t("circuitBreaker.thresholdHint")}
            >
              <Input
                id="eh-cb-threshold"
                type="number"
                min={1}
                value={breaker.threshold}
                onChange={(e) =>
                  patch({
                    circuitBreaker: {
                      ...breaker,
                      threshold: Math.max(1, Number(e.target.value) || 1),
                    },
                  })
                }
              />
            </Field>
            <Field
              label={t("circuitBreaker.cooldownMs")}
              htmlFor="eh-cb-cooldown"
              hint={t("circuitBreaker.cooldownHint")}
            >
              <Input
                id="eh-cb-cooldown"
                type="number"
                min={0}
                step={1000}
                value={breaker.cooldownMs}
                onChange={(e) =>
                  patch({
                    circuitBreaker: {
                      ...breaker,
                      cooldownMs: Math.max(0, Number(e.target.value) || 0),
                    },
                  })
                }
              />
            </Field>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
