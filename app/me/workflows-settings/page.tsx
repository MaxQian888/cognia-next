"use client"

/**
 * Mobile Workflow settings page (ADR-0056). Exposes the single pure-store
 * workflow setting that is device-meaningful: the visual-editor performance
 * tier (`workflowEditorPerformanceTier`, owned by the desktop `workflows`
 * section — see `lib/settings/section-keys.ts`).
 *
 * The tier governs how much motion / live computation the React Flow editor
 * runs (`lib/workflow/editor/performance-tier.ts`). It is a per-device
 * capability knob, so it is NOT mirrored desktop→phone
 * (`CROSS_PLATFORM_SETTING_KEYS`) — the phone keeps its own value — but it IS
 * writable up via the `app_settings_update` allowlist so a paired desktop's
 * tier can be set from here. Writes go through `useSettingsPatch` (decision
 * D7). Both runtime modes (no `<PairedOnly>`): the workflow editor exists on
 * the phone too.
 */

import { useTranslations } from "next-intl"

import { MeSection } from "@/components/mobile/me/me-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Item, ItemContent, ItemTitle } from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { isPerformanceTier, type PerformanceTier } from "@/lib/workflow/editor/performance-tier"
import { useSettingsStore } from "@/stores/settings"

const TIERS: PerformanceTier[] = ["auto", "high", "balanced", "reduced"]

const TIER_LABEL_KEY: Record<PerformanceTier, string> = {
  auto: "tierAuto",
  high: "tierHigh",
  balanced: "tierBalanced",
  reduced: "tierReduced",
}

export default function MobileWorkflowsSettingsPage() {
  const t = useTranslations("mobile.workflowsSettings")
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsPatch()

  const raw = settings?.workflowEditorPerformanceTier
  const tier: PerformanceTier = isPerformanceTier(raw) ? raw : "auto"

  return (
    <SubPageShell
      title={t("title")}
      backAria={t("backAria")}
      testid="mobile-workflows-settings-page"
    >
      <MeSection
        title={t("sectionTitle")}
        description={t("sectionDescription")}
        testid="me-section-workflows-settings"
      >
        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemTitle className="text-xs">{t("tierLabel")}</ItemTitle>
            <Select
              value={tier}
              onValueChange={(v) =>
                isPerformanceTier(v) ? void update({ workflowEditorPerformanceTier: v }) : undefined
              }
            >
              <SelectTrigger
                data-testid="workflow-perf-tier"
                aria-label={t("tierLabel")}
                className="mt-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIERS.map((tierId) => (
                  <SelectItem key={tierId} value={tierId}>
                    {t(TIER_LABEL_KEY[tierId])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t("tierHelp")}</p>
          </ItemContent>
        </Item>
      </MeSection>
    </SubPageShell>
  )
}
