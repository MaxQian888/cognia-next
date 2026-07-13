"use client"

/**
 * Provider/model switcher chip for the Inbox conversation header
 * (ADR-0009 v41 / A6).
 *
 * Renders a clickable badge that opens a dropdown listing the configured
 * providers + models from app settings. Selecting one writes
 * `providerOverride` / `modelOverride` to ConversationOverrideRow via
 * `upsertByConversationKey`; the next AI turn driven by this conversation
 * picks them up at the top of the precedence chain in `resolveSendOptions`.
 *
 * Mirrors the `ModeSwitcher` pattern so the inbox header chrome stays
 * uniform. Clearing the override is exposed as a `default` menu entry
 * that writes `undefined` to both fields.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { getDb } from "@/lib/db/schema"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import type { AppSettings } from "@cognia/agent-config-types"

interface ProviderModelSwitcherProps {
  conversationKey: string
  sessionId: string
  /** Current override row values, or undefined when not set. */
  providerOverride?: string
  modelOverride?: string
  onChange?: (next: { providerOverride?: string; modelOverride?: string }) => void
}

export interface ProviderModelOption {
  providerId: string
  modelId: string
  /** Display label for the menu item. */
  label: string
}

/**
 * Enumerate the configured provider+model pairs from app settings. Exported
 * (pure) so the adapter-detail `AiBindingDefaults` section reuses the exact
 * same option source as this per-conversation switcher.
 */
export function collectOptions(settings: AppSettings | undefined): ProviderModelOption[] {
  const out: ProviderModelOption[] = []
  if (!settings) return out

  // Provider settings map: provider id → {enabled, models?}.
  const providerSettings = (settings.providerSettings ?? {}) as Record<
    string,
    { enabled?: boolean; models?: string[]; defaultModel?: string }
  >
  for (const [providerId, cfg] of Object.entries(providerSettings)) {
    if (cfg.enabled === false) continue
    const models = cfg.models ?? (cfg.defaultModel ? [cfg.defaultModel] : [])
    for (const modelId of models) {
      out.push({
        providerId,
        modelId,
        label: `${providerId} · ${modelId}`,
      })
    }
  }

  // Custom providers from `customProviders` array.
  const customProviders = (settings.customProviders ?? []) as Array<{
    id: string
    enabled?: boolean
    models?: string[]
  }>
  for (const p of customProviders) {
    if (p.enabled === false) continue
    for (const modelId of p.models ?? []) {
      out.push({
        providerId: p.id,
        modelId,
        label: `${p.id} · ${modelId}`,
      })
    }
  }

  return out
}

export function ProviderModelSwitcher({
  conversationKey,
  sessionId,
  providerOverride,
  modelOverride,
  onChange,
}: ProviderModelSwitcherProps) {
  const t = useTranslations("inbox.providerModelSwitcher")
  const [pending, setPending] = useState(false)

  const settings = useLiveQuery<AppSettings | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().settings.get("singleton"),
    []
  )

  const options = collectOptions(settings)

  const label =
    providerOverride && modelOverride
      ? `${providerOverride} · ${modelOverride}`
      : providerOverride
        ? providerOverride
        : modelOverride
          ? modelOverride
          : t("default")

  const handleSelect = async (next: { providerOverride?: string; modelOverride?: string }) => {
    if (
      pending ||
      (next.providerOverride === providerOverride && next.modelOverride === modelOverride)
    ) {
      return
    }
    setPending(true)
    try {
      await upsertByConversationKey({
        conversationKey,
        sessionId,
        providerOverride: next.providerOverride,
        modelOverride: next.modelOverride,
      })
      onChange?.(next)
    } finally {
      setPending(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending}
          data-testid="provider-model-switcher-trigger"
          aria-label={t("aria")}
        >
          <Badge variant="outline" className="cursor-pointer select-none font-mono">
            {label}
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] overflow-y-auto">
        <DropdownMenuLabel>{t("title")}</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() =>
            void handleSelect({ providerOverride: undefined, modelOverride: undefined })
          }
          data-testid="provider-model-option-default"
        >
          {t("clearOverride")}
        </DropdownMenuItem>
        {options.length > 0 && <DropdownMenuSeparator />}
        {options.map((opt) => (
          <DropdownMenuItem
            key={`${opt.providerId}:${opt.modelId}`}
            onClick={() =>
              void handleSelect({
                providerOverride: opt.providerId,
                modelOverride: opt.modelId,
              })
            }
            data-testid={`provider-model-option-${opt.providerId}-${opt.modelId}`}
          >
            {opt.label}
          </DropdownMenuItem>
        ))}
        {options.length === 0 && (
          <DropdownMenuItem disabled data-testid="provider-model-option-empty">
            {t("noProvidersConfigured")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
