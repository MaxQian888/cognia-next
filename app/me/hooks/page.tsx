"use client"

/**
 * Mobile Hooks page (ADR-0056, decision D6 — desktop-bound section, read-only
 * on mobile). User / project / local lifecycle hooks live in
 * `.claude/settings.json` and are read + written through the desktop Rust
 * runtime (`lib/claude/settings`), which has no mobile counterpart — so the
 * phone cannot read the user's configured hooks and editing stays "manage on
 * desktop".
 *
 * What the phone CAN surface without fabricating data is the product's static
 * built-in hook catalog (`BUILTIN_HOOKS`, importable client-side), shown with
 * its translated labels (reusing the desktop `settings.hooks.builtin` i18n
 * namespace) and each entry's default-enabled state. This is a `<PairedOnly>`
 * view because the surrounding config it documents only exists when paired.
 */

import { useTranslations } from "next-intl"
import { MonitorSmartphoneIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { BUILTIN_HOOKS } from "@/lib/claude/hooks/builtin-hooks"

function HooksBody() {
  const t = useTranslations("mobile.hooks")
  const tb = useTranslations("settings.hooks.builtin")

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="hooks-intro">
        {t("intro")}
      </p>

      <MeSection
        title={t("builtin.title")}
        description={t("builtin.description")}
        testid="me-section-hooks-builtin"
      >
        {BUILTIN_HOOKS.map((def) => (
          <Item key={def.id} size="sm" className="px-0" data-testid={`hook-row-${def.id}`}>
            <ItemContent>
              <ItemTitle className="flex items-center gap-2 text-sm">
                <span className="truncate">{tb(`items.${def.id}.label`)}</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {def.event}
                </Badge>
              </ItemTitle>
              <ItemDescription className="line-clamp-2">
                {tb(`items.${def.id}.desc`)}
              </ItemDescription>
            </ItemContent>
            <Badge variant={def.defaultEnabled ? "default" : "outline"}>
              {def.defaultEnabled ? t("defaultOn") : t("defaultOff")}
            </Badge>
          </Item>
        ))}
      </MeSection>

      <div
        className="flex items-start gap-3 rounded-xl border bg-card px-3 py-3 text-xs text-muted-foreground"
        data-testid="hooks-manage-note"
      >
        <MonitorSmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t("manageOnDesktop")}</p>
      </div>
    </div>
  )
}

export default function MobileHooksPage() {
  const t = useTranslations("mobile.hooks")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-hooks-page">
      <PairedOnly>
        <HooksBody />
      </PairedOnly>
    </SubPageShell>
  )
}
