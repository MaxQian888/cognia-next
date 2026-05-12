"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MARKETPLACE_TEASERS } from "@/lib/skills/marketplace-teasers"

/**
 * Empty state shown in the Marketplace tab when SkillsMP isn't configured.
 * Renders teaser cards plus a settings link.
 */
export function SkillMarketplaceEmpty() {
  const t = useTranslations("skills.marketplaceEmpty")
  return (
    <div
      data-testid="skill-marketplace-empty"
      className="flex flex-1 flex-col items-center gap-6 px-6 py-12"
    >
      <div className="text-center">
        <SparklesIcon className="mx-auto size-8 text-muted-foreground" />
        <h3 className="mt-2 text-base font-semibold">{t("title")}</h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Button asChild>
        <Link href="/settings?section=skills-marketplace">
          {t("configure")}
          <ArrowRightIcon className="ml-1 size-4" />
        </Link>
      </Button>
      <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-2">
        {MARKETPLACE_TEASERS.map((m) => (
          <div key={m.id} className="rounded-md border p-4 opacity-80">
            <div className="text-sm font-semibold">{m.name}</div>
            <div className="mt-1 text-xs text-muted-foreground">{m.description}</div>
            <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              {m.author} · {m.category}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
