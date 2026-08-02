"use client"

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { RELEASES } from "@/lib/constants/release-notes"
import { RELEASES_URL } from "@/lib/constants/external-urls"
import { openExternal } from "@/lib/tauri/opener"

import { AboutCard } from "./about-card"

/** Format an ISO date (YYYY-MM-DD) for display; passthrough on failure. */
function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

/**
 * "What's new" feed — an accordion over the curated, offline release notes in
 * `lib/constants/release-notes.ts`. Highlight text is translated; a footer
 * link opens the full GitHub releases history.
 */
export function WhatsNewCard() {
  const t = useTranslations("settings.about")
  const latest = RELEASES[0]?.version

  return (
    <AboutCard icon={SparklesIcon} title={t("whatsNew.title")} testid="about-whatsnew-card">
      <Accordion type="single" collapsible defaultValue={latest}>
        {RELEASES.map((release) => (
          <AccordionItem key={release.version} value={release.version}>
            <AccordionTrigger data-testid={`whatsnew-trigger-${release.version}`}>
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-xs">
                  {release.version}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {formatDate(release.date)}
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                {release.highlightKeys.map((key) => (
                  <li key={key} className="flex gap-2">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
                    <span className="min-w-0 text-pretty">{t(`whatsNew.highlights.${key}`)}</span>
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>

      <Button
        variant="link"
        size="sm"
        className="mt-1 h-8 px-0 text-xs"
        onClick={() => void openExternal(RELEASES_URL)}
        data-testid="whatsnew-view-all"
      >
        {t("whatsNew.viewAll")}
      </Button>
    </AboutCard>
  )
}
