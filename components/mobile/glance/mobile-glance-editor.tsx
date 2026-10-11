"use client"

/**
 * The phone's one layout editor (ADR-0225 §9, §12): which modules the Glance
 * drawer shows, in what order and size, which of them are pinned to the home
 * screen, the preset they came from, and the quick module's shortcuts. When a
 * paired desktop has sent its tray layout, it can be copied here.
 *
 * Rendered in two places, the drawer's edit mode and the home-layout sheet
 * (the app bar's ⋮ menu), so the layout is reachable even when the home
 * screen shows nothing. Every change is saved at once.
 *
 * Plugin modules are offered from the phone's own plugins when standalone and
 * from the paired desktop's (which the editor asks for while open).
 */

import { useId } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon } from "lucide-react"
import { toast } from "sonner"

import { GlanceLayoutEditor } from "@/components/glance/glance-layout-editor"
import { GlancePresetMenu } from "@/components/glance/glance-preset-menu"
import { Button } from "@/components/ui/button"
import { pinnedLayout } from "@/hooks/glance/use-mobile-glance"
import { withEditedMobileEntries, withMobilePreset, withShortcuts } from "@/lib/glance/layout-edit"
import { mobileEntriesFromDesktop } from "@/lib/glance/mobile-layout"
import { glanceModulesFor } from "@/lib/glance/registry"
import type {
  GlanceMobileEntry,
  GlanceMobileSettings,
  GlanceModuleSize,
  GlancePluginEntryId,
} from "@/types/glance/layout"

import { useMobileGlanceContext, useRegisterGlanceEditor } from "./mobile-glance-provider"
import { MobileShortcutsEditor } from "./mobile-shortcuts-editor"

const MOBILE_MODULES = glanceModulesFor("mobile")

/** A plugin module's first entry on a phone: shown in the drawer, not pinned. */
function makeMobileEntry(id: GlancePluginEntryId, size: GlanceModuleSize): GlanceMobileEntry {
  return { id, size, hidden: false, home: false }
}

export function MobileGlanceEditor() {
  const t = useTranslations("glance.mobile")
  const tGlance = useTranslations("glance")
  const { settings, save, paired, hostLayout, pluginCatalog } = useMobileGlanceContext()
  const hintId = useId()
  useRegisterGlanceEditor()
  const pluginIds = pluginCatalog.map((entry) => entry.id)

  const commit = (next: GlanceMobileSettings) => {
    void save(next).then((errorKey) => {
      if (errorKey) toast.error(tGlance(errorKey))
    })
  }
  const pins = new Map(settings.entries.map((entry) => [entry.id, entry.home]))

  return (
    <div className="space-y-6" data-testid="mobile-glance-editor">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("preset")}</span>
        <GlancePresetMenu
          preset={settings.preset}
          onApply={(preset) => commit(withMobilePreset(settings, preset))}
          className="min-h-9 border text-sm"
        />
        {paired ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ms-auto h-9 gap-1.5"
            disabled={!hostLayout}
            aria-describedby={hostLayout ? undefined : hintId}
            onClick={() => {
              if (!hostLayout) return
              commit(
                withEditedMobileEntries(
                  settings,
                  mobileEntriesFromDesktop(hostLayout.entries, settings.entries)
                )
              )
              toast.success(t("copiedDesktop"))
            }}
            data-testid="mobile-glance-copy-desktop"
          >
            <CopyIcon aria-hidden className="size-3.5" />
            {t("copyDesktop")}
          </Button>
        ) : null}
      </div>
      {paired && !hostLayout ? (
        <p
          id={hintId}
          className="-mt-4 text-xs text-muted-foreground"
          data-testid="mobile-glance-copy-hint"
        >
          {t("copyDesktopUnavailable")}
        </p>
      ) : null}

      <section className="space-y-1">
        <p className="text-xs text-muted-foreground">{t("homeHint")}</p>
        <GlanceLayoutEditor
          entries={settings.entries}
          onChange={(entries) => commit(withEditedMobileEntries(settings, entries))}
          available={MOBILE_MODULES}
          plugins={pluginCatalog}
          makeEntry={makeMobileEntry}
          density="touch"
          home={{
            isPinned: (id) => pins.get(id) === true,
            onToggle: (id, home) => commit(pinnedLayout(settings, id, home, pluginIds)),
          }}
        />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("shortcuts")}</h3>
        <p className="text-xs text-muted-foreground">{t("shortcutsHint")}</p>
        <MobileShortcutsEditor
          shortcuts={settings.shortcuts}
          onChange={(shortcuts) => commit(withShortcuts(settings, shortcuts))}
        />
      </section>
    </div>
  )
}
