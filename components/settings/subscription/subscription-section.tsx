"use client"

// Unified Subscription settings section (ADR-0025). Master/detail shell — a
// grouped nav on the left, one panel on the right. Mirrors `appearance-section.tsx`
// / `ocr-section.tsx`, the house pattern for sections with more entries than a
// tab strip can carry: below `md` the nav collapses into a left Sheet.
// `subscription` is a member of the shell's `FILL_HEIGHT_SECTIONS`, so this
// component owns its own scroll and fills the frame.
//
// This replaced two nested tab strips (provider Tabs → Anthropic inner Tabs)
// plus two cards — import/export and cloud sync — that hung off the bottom of
// the section with no nav entry at all, below however far the active tab
// happened to scroll. Both are now first-class panels under `vaultGroup`.
// See `nav-config.ts` for the grouping rationale and the legacy `?subTab=` /
// `?innerTab=` deep-link mapping.
//
// URL params:
//   ?subTab=<panel>   — the active panel id (single source of truth).
//   ?innerTab=<inner> — legacy, Anthropic-only; still resolved, never written.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { MenuIcon, ZapIcon } from "lucide-react"

import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"

import { CloudSyncCard } from "./cloud-sync-card"
import { ImportExportButtons } from "./import-export-buttons"
import { ProviderTabCodex } from "./provider-tab-codex"
import { ProviderTabOpencode } from "./provider-tab-opencode"
import { ClaudeAccountPanel } from "./panels/claude-account-panel"
import { SubscriptionNav } from "./components/subscription-nav"
import { SubscriptionOverviewTab } from "./tabs/overview-tab"
import { SubscriptionSettingsTab } from "./tabs/settings-tab"
import { SubscriptionUsageTab } from "./tabs/usage-tab"
import {
  SUBSCRIPTION_NAV_GROUPS,
  resolveSubscriptionPanel,
  type SubscriptionPanelId,
} from "./nav-config"

const SUBTAB_PARAM = "subTab"
const INNER_TAB_PARAM = "innerTab"

function renderPanel(panel: SubscriptionPanelId, onRequestAddAccount: () => void) {
  switch (panel) {
    case "overview":
      return <SubscriptionOverviewTab onRequestAddAccount={onRequestAddAccount} />
    case "usage":
      return <SubscriptionUsageTab />
    case "probes":
      return <SubscriptionSettingsTab />
    case "claude":
      return <ClaudeAccountPanel />
    case "codex":
      return <ProviderTabCodex />
    case "opencode":
      return <ProviderTabOpencode />
    case "backup":
      return <ImportExportButtons />
    case "sync":
      return <CloudSyncCard />
  }
}

export function SubscriptionSection() {
  const t = useTranslations("subscription")
  const router = useRouter()
  const searchParams = useSearchParams()
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)

  const activePanel = resolveSubscriptionPanel(
    searchParams.get(SUBTAB_PARAM),
    searchParams.get(INNER_TAB_PARAM)
  )

  const select = (id: SubscriptionPanelId) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(SUBTAB_PARAM, id)
    // The panel id is now self-contained; a stale `innerTab` would outrank it
    // on the next read (see `resolveSubscriptionPanel`), so drop it.
    params.delete(INNER_TAB_PARAM)
    router.replace(`?${params.toString()}`, { scroll: false })
    setMobileSheetOpen(false)
  }

  // The Overview panel's empty state offers "add an account", which is the
  // Claude panel's job — route there rather than making Overview own a dialog.
  const goToClaudeAccounts = () => select("claude")

  const navNode = (
    <SubscriptionNav groups={SUBSCRIPTION_NAV_GROUPS} activeId={activePanel} onSelect={select} />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <ZapIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <RelatedSectionsStrip current="subscription" targets={CLAUDE_CODE_RELATED} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
        {/* Desktop nav */}
        <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
          {navNode}
        </div>

        {/* Below md the nav lives in a Sheet; the bar shows where you are. */}
        <div className="flex items-center gap-2 md:hidden">
          <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                data-testid="subscription-mobile-nav-trigger"
              >
                <MenuIcon className="size-4" />
                {t("nav.mobileTrigger")}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px] p-0">
              <SheetHeader className="px-3 pt-3">
                <SheetTitle className="text-sm">{t("nav.title")}</SheetTitle>
              </SheetHeader>
              {navNode}
            </SheetContent>
          </Sheet>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {t(`nav.items.${activePanel}.label`)}
          </p>
        </div>

        {/* Detail. `@container/subscription-pane`: panels are now a fixed-ish
            width regardless of viewport, so any multi-column layout inside them
            must size off this box, not the window (same as the appearance and
            hooks panes). */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div
            className="@container/subscription-pane min-h-0 flex-1 overflow-y-auto p-3"
            data-testid="subscription-panel-body"
          >
            {renderPanel(activePanel, goToClaudeAccounts)}
          </div>
        </div>
      </div>
    </div>
  )
}
