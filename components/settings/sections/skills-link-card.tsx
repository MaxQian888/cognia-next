"use client"

import Link from "next/link"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, SparklesIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { listSkills } from "@/lib/db/skills"

interface Props {
  /** Optional close handler — called before navigating, in case the host is a Sheet. */
  onClose?: () => void
}

/**
 * Compact Skills summary shown inside the Settings shell. Full management UI
 * lives at `/skills`; this card surfaces a one-glance summary (counts by
 * source) and a deep-link.
 */
export function SkillsLinkCard({ onClose }: Props) {
  const t = useTranslations("skills")
  const skills = useLiveQuery(() => listSkills(), [])

  const counts = (() => {
    const total = skills?.length ?? 0
    const builtin =
      skills?.filter((s) => (s.source ?? (s.isBuiltIn ? "builtin" : "custom")) === "builtin")
        .length ?? 0
    const custom = total - builtin
    const enabled = skills?.filter((s) => (s.status ?? "enabled") === "enabled").length ?? 0
    return { total, builtin, custom, enabled }
  })()

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <SparklesIcon className="size-4" />
          {t("settingsCardTitle")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("settingsCardDescription")}</p>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {t("badgeTotal", { count: counts.total })}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {t("badgeEnabled", { count: counts.enabled })}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {t("badgeBuiltin", { count: counts.builtin })}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {t("badgeCustom", { count: counts.custom })}
            </Badge>
          </div>
          <Button asChild size="sm" onClick={() => onClose?.()}>
            <Link href="/skills">
              {t("manageButton")}
              <ArrowRightIcon className="ml-1.5 size-3.5" />
            </Link>
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("settingsCardFooter")}</p>
      </Card>
    </div>
  )
}
