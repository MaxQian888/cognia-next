"use client"

/**
 * The quick module on a phone (ADR-0225 §9): the layout's shortcut list,
 * which used to be the home screen's quick-action grid.
 *
 * `standard` is the grid, two or four columns of illustrated tiles; `compact`
 * is one row of icons. Tiles are buttons on the module's surface, not cards:
 * the module already sits in the glance container, and a card in it would be
 * a card in a card (§3). Editing the list is the layout editor's job; the
 * module's own "Edit" opens it.
 */

import { useMemo } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { SlidersHorizontalIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { useGlance } from "@/components/glance/glance-context"
import {
  GlanceCompactSection,
  GlanceLinkButton,
  GlanceSection,
} from "@/components/glance/glance-primitives"
import { MobileSpotIcon } from "@/components/mobile/mobile-spot-icon"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { getMobileQuickActionCatalog, type MobileQuickActionItem } from "@/lib/shell/mobile-home-nav"
import { MOBILE_SPRING, STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { useMobileGlanceContext } from "./mobile-glance-provider"

export function MobileGlanceQuickModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.quick")
  const tActions = useTranslations("mobile.home.actions")
  const router = useRouter()
  const reduce = useReducedMotion()
  const { route } = useGlance()
  const { settings, actions } = useMobileGlanceContext()

  const items = useMemo(() => {
    const byId = new Map(getMobileQuickActionCatalog().map((item) => [item.id, item]))
    return settings.shortcuts
      .map((id) => byId.get(id))
      .filter((item): item is MobileQuickActionItem => item !== undefined)
  }, [settings.shortcuts])

  const dispatch = (item: MobileQuickActionItem) => {
    void selectionFeedback()
    if (item.kind === "newChat") actions.newChat()
    else if (item.kind === "search") actions.search()
    else if (item.kind === "route" && item.route) router.push(item.route)
  }
  const edit = () => route({ kind: "open-owner", owner: "tray-actions" })
  const title = t("label")

  if (items.length === 0) {
    return (
      <GlanceCompactSection moduleId="quick" title={title} label={t("editShortcuts")} onClick={edit}>
        <span className="text-muted-foreground">{t("noShortcuts")}</span>
      </GlanceCompactSection>
    )
  }

  if (size === "compact") {
    return (
      <section data-glance-module="quick" aria-label={title} className="min-w-0 px-5 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <span className="w-14 shrink-0 text-[13px] font-semibold text-muted-foreground">
            {title}
          </span>
          <div className="-my-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {items.map((item) => {
              const label = tActions(item.i18nKey)
              return (
                <button
                  key={item.id}
                  type="button"
                  data-glance-nav
                  aria-label={label}
                  title={label}
                  data-testid={`mobile-quick-action-${item.id}`}
                  onClick={() => dispatch(item)}
                  className="grid size-11 shrink-0 place-items-center rounded-lg text-foreground transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <item.Icon aria-hidden className="size-5" />
                </button>
              )
            })}
          </div>
        </div>
      </section>
    )
  }

  return (
    <GlanceSection
      moduleId="quick"
      title={title}
      aside={
        <GlanceLinkButton label={t("editShortcuts")} onClick={edit}>
          <SlidersHorizontalIcon aria-hidden className="size-3" />
          {t("edit")}
        </GlanceLinkButton>
      }
    >
      {/* The home screen's centrepiece on a first launch: the tiles deal
          themselves in, and each takes a press. */}
      <motion.div
        className="-mx-1.5 grid grid-cols-2 gap-1 sm:grid-cols-4"
        variants={reduce ? undefined : STAGGER_CONTAINER}
        initial={reduce ? false : "initial"}
        animate="animate"
        data-testid="mobile-quick-actions"
      >
        {items.map((item) => (
          <motion.button
            key={item.id}
            type="button"
            data-glance-nav
            data-testid={`mobile-quick-action-${item.id}`}
            onClick={() => dispatch(item)}
            variants={reduce ? undefined : STAGGER_CHILD}
            whileTap={reduce ? undefined : { scale: 0.95 }}
            transition={MOBILE_SPRING}
            className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-xl p-2 text-center transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <MobileSpotIcon name={item.spotIcon} size={52} className="-my-1" />
            <span className="line-clamp-1 text-xs font-medium">{tActions(item.i18nKey)}</span>
          </motion.button>
        ))}
      </motion.div>
    </GlanceSection>
  )
}

