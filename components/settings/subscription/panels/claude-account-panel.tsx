"use client"

// The Claude (Anthropic) provider panel: accounts, quota, presets, and the
// credential detail — the same concerns the Codex and OpenCode panels own, so
// all three providers now read the same way.
//
// Under the old nested tabs the account list and preset picker were rendered by
// `provider-tab-anthropic.tsx` ABOVE the inner strip, which made them look like
// a header for Overview/Usage rather than Claude's own account surface. Here
// they are the panel. `SubscriptionAccountTab` supplies the credential detail
// (plan, expiry, sign-in/out) it always did.
//
// The quota panel is shared with the other providers; the Overview panel's
// richer Anthropic gauges stay where they are, since those are Claude-specific
// and this panel is about the credential.

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"

import { AccountList } from "../account-list"
import { AnthropicAddAccountDialog } from "../add-account-dialog/anthropic"
import { PresetPicker } from "../preset-picker"
import { ProviderQuotaPanel } from "../provider-quota-panel"
import { SubscriptionAccountTab } from "../tabs/account-tab"

export function ClaudeAccountPanel() {
  const t = useTranslations("subscription.nav.items.claude")
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("label")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <AccountList provider="anthropic" onAdd={() => setAddOpen(true)} />
      <ProviderQuotaPanel provider="anthropic" />
      <PresetPicker provider="anthropic" />
      <SubscriptionAccountTab onRequestAddAccount={() => setAddOpen(true)} />

      <AnthropicAddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}
