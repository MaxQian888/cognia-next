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
 *
 * The option source is `collectModelOptions` — the same one the composer
 * picker, the settings default-model picker, the routing alias combobox, and
 * the routing engine's candidate set all read. This file used to collect its
 * own, against an invented settings shape (`cfg.models`, a field that does not
 * exist on `UserProviderSettings`), so every built-in provider offered exactly
 * one model: its default. Discovered models, the OpenRouter catalog, and every
 * enabled-model whitelist were invisible here and in the bot default-model
 * dropdown that imports from this file.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/schema"
import { collectModelOptions } from "@/lib/ai/model-options"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
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
 * Enumerate the selectable provider+model pairs. Exported (pure) so the
 * adapter-detail `AiBindingDefaults` section reuses the exact same option
 * source as this per-conversation switcher.
 *
 * No local collection: `collectModelOptions` takes the real settings types, so
 * a field that does not exist on `UserProviderSettings` is a compile error
 * rather than a silently-empty list.
 */
export function collectOptions(settings: AppSettings | undefined): ProviderModelOption[] {
  if (!settings) return []
  return collectModelOptions(settings.providerSettings, settings.customProviders).map((option) => ({
    providerId: option.providerId,
    modelId: option.modelId,
    // Display names, not raw ids — `openai · gpt-5.4` was never a label a
    // person picked out of a list of thirty.
    label: `${option.providerName} · ${option.modelName ?? option.modelId}`,
  }))
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
      await mutateConversationOverride({
        kind: "upsert",
        input: {
          conversationKey,
          sessionId,
          providerOverride: next.providerOverride,
          modelOverride: next.modelOverride,
        },
      })
      onChange?.(next)
    } finally {
      setPending(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          data-testid="provider-model-switcher-trigger"
          aria-label={t("aria")}
          className="h-6 max-w-48 px-2 font-mono text-xs"
        >
          <span className="truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("title")}</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() =>
              void handleSelect({ providerOverride: undefined, modelOverride: undefined })
            }
            data-testid="provider-model-option-default"
          >
            {t("clearOverride")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {options.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuGroup>
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
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
