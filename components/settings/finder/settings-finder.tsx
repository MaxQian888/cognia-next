"use client"

/**
 * Control-level settings finder — a ⌘/Ctrl+K command palette that searches both
 * sections (reusing `SETTINGS_SEARCH_KEYWORDS`) and individual controls (from
 * the curated `SETTING_CONTROLS` registry). Selecting a control navigates to
 * `?section=X&focus=<id>`; `useSettingFocus` then scrolls + highlights the
 * matching `data-setting-id` anchor (degrading to section-level when none).
 *
 * Built on the installed shadcn `CommandDialog` (cmdk) — no bespoke search UI.
 */

import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  SETTINGS_NAV,
  SETTINGS_SEARCH_KEYWORDS,
  type SettingsSectionId,
} from "@/components/settings/settings-nav-config"
import { SETTING_CONTROLS } from "./control-registry"

const SECTION_LABEL_KEY: Record<SettingsSectionId, string> = Object.fromEntries(
  SETTINGS_NAV.map((n) => [n.id, n.labelKey])
) as Record<SettingsSectionId, string>

export function SettingsFinder({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("settings")
  const router = useRouter()
  const searchParams = useSearchParams()

  const sectionLabel = (id: SettingsSectionId) => t(`tabs.${SECTION_LABEL_KEY[id]}` as never)

  const navigate = (sectionId: SettingsSectionId, focusId?: string) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("section", sectionId)
    if (focusId) next.set("focus", focusId)
    else next.delete("focus")
    router.replace(`/settings?${next.toString()}`, { scroll: false })
    onOpenChange(false)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("finder.title")}
      description={t("finder.description")}
    >
      <CommandInput placeholder={t("finder.placeholder")} data-testid="settings-finder-input" />
      <CommandList>
        <CommandEmpty>{t("finder.empty")}</CommandEmpty>

        <CommandGroup heading={t("finder.controlsHeading")}>
          {SETTING_CONTROLS.map((c) => {
            const label = t(`finder.controls.${c.labelKey}` as never)
            return (
              <CommandItem
                key={c.id}
                value={`control:${c.id}`}
                keywords={[label, sectionLabel(c.sectionId), ...(c.keywords ?? [])]}
                onSelect={() => navigate(c.sectionId, c.id)}
                data-testid="finder-control"
              >
                <span className="truncate">{label}</span>
                <span className="ml-auto pl-2 text-xs text-muted-foreground">
                  {sectionLabel(c.sectionId)}
                </span>
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandGroup heading={t("finder.sectionsHeading")}>
          {SETTINGS_NAV.map((n) => (
            <CommandItem
              key={n.id}
              value={`section:${n.id}`}
              keywords={SETTINGS_SEARCH_KEYWORDS[n.id]}
              onSelect={() => navigate(n.id)}
              data-testid="finder-section"
            >
              {sectionLabel(n.id)}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
