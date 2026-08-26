"use client"

/**
 * Durable media-consent editor for one conversation.
 *
 * The other half of `MediaModelGrant`'s two entries: the in-chat card
 * (`lib/connectors/hitl/media-grant.ts`) is the moment consent is a question,
 * this is where the answer is inspected, scoped and withdrawn. Until both
 * existed the field had no writer at all, so `allow_cloud_binary` was
 * unreachable and every inbound image was withheld from the model forever.
 *
 * Provider-scoped on purpose, and the UI insists on it: "you may show this to
 * the vision model running on this machine" and "you may upload this to a third
 * party" are different decisions, and a grant that did not name which one it
 * meant would silently transfer the moment the conversation's provider changed.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { MediaModelGrant } from "@/lib/connectors/media-model-gate"

export interface MediaGrantEditorProps {
  value: MediaModelGrant | undefined
  onChange: (next: MediaModelGrant | undefined) => void
  /** Providers this conversation could actually resolve to. */
  providers: string[]
  /** What the conversation runs on today, so the default scope is the useful one. */
  effectiveProvider?: string
  /** Injectable clock; the component captures one at mount otherwise. */
  now?: number
}

/** Expiry presets, in hours. `0` is the no-expiry option. */
const DURATIONS = [24, 24 * 7, 0] as const

export function MediaGrantEditor({
  value,
  onChange,
  providers,
  effectiveProvider,
  now: nowProp,
}: MediaGrantEditorProps) {
  const t = useTranslations("inbox.conversationOverride.mediaGrant")
  // Captured once rather than read on every render: an expiry that drifted
  // while the operator typed would move the very deadline they are choosing,
  // and reading the clock during render is impure besides.
  const [mountedAt] = useState(() => Date.now())
  const now = nowProp ?? mountedAt

  const enabled = value?.policy === "allow_cloud_binary"
  const expired = typeof value?.expiresAt === "number" && value.expiresAt <= now
  const granted = value?.providers ?? []
  // Offer what the conversation could run on, plus anything already granted so
  // a grant for a provider that has since been removed stays visible and
  // revocable rather than disappearing from the screen while staying in the row.
  const options = Array.from(new Set([...providers, ...granted])).filter(Boolean)

  const setEnabled = (next: boolean) => {
    if (!next) {
      onChange(undefined)
      return
    }
    onChange({
      policy: "allow_cloud_binary",
      // Seeded with the provider the conversation actually uses. An empty
      // provider list grants nothing, which would make the switch a lie.
      providers: effectiveProvider ? [effectiveProvider] : options.slice(0, 1),
      grantedAt: now,
      expiresAt: now + 24 * 60 * 60 * 1_000,
    })
  }

  const toggleProvider = (provider: string, on: boolean) => {
    if (!value) return
    const next = on
      ? Array.from(new Set([...value.providers, provider]))
      : value.providers.filter((entry) => entry !== provider)
    onChange({ ...value, providers: next })
  }

  const setDuration = (hours: number) => {
    if (!value) return
    onChange({
      ...value,
      // Re-stamp so "24 hours" means 24 hours from this edit, not from a grant
      // made last week.
      grantedAt: now,
      ...(hours > 0 ? { expiresAt: now + hours * 3_600_000 } : { expiresAt: undefined }),
    })
  }

  const currentHours = value?.expiresAt
    ? Math.round((value.expiresAt - value.grantedAt) / 3_600_000)
    : 0

  return (
    <div className="space-y-3" data-testid="media-grant-editor">
      <div className="flex items-start gap-3">
        <Switch
          id="conv-override-media-grant"
          checked={enabled}
          onCheckedChange={setEnabled}
          data-testid="conv-override-media-grant"
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor="conv-override-media-grant" className="cursor-pointer">
            {t("label")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("help")}</p>
        </div>
      </div>

      {enabled && value && (
        <div className="space-y-3 pl-11">
          {/* An expired grant is inert without a sweep, so the row can still
           * hold one. Saying so beats rendering it as if it were in force. */}
          {expired && (
            <Badge variant="outline" className="text-destructive" data-testid="media-grant-expired">
              {t("expired")}
            </Badge>
          )}

          <div className="space-y-2">
            <Label>{t("providers")}</Label>
            {options.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="media-grant-no-providers">
                {t("noProviders")}
              </p>
            ) : (
              options.map((provider) => (
                <div key={provider} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs">{provider}</span>
                  <Switch
                    checked={value.providers.includes(provider)}
                    onCheckedChange={(on) => toggleProvider(provider, on)}
                    aria-label={t("providerAria", { provider })}
                    data-testid={`media-grant-provider-${provider}`}
                  />
                </div>
              ))
            )}
            {/* A grant with no providers grants nothing — the resolver reads it
             * as absent. Better to say that than to leave a switch that is on
             * and inert. */}
            {value.providers.length === 0 && options.length > 0 && (
              <p className="text-xs text-destructive" data-testid="media-grant-empty">
                {t("noneSelected")}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="conv-override-media-grant-duration">{t("duration")}</Label>
            <Select
              value={String(currentHours)}
              onValueChange={(next) => setDuration(Number(next))}
            >
              <SelectTrigger
                id="conv-override-media-grant-duration"
                data-testid="media-grant-duration"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map((hours) => (
                  <SelectItem key={hours} value={String(hours)}>
                    {t(`duration_${hours}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => onChange(undefined)}
            data-testid="media-grant-revoke"
          >
            {t("revoke")}
          </Button>
        </div>
      )}
    </div>
  )
}
