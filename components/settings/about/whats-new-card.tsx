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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { RELEASES } from "@/lib/constants/release-notes"
import { RELEASES_URL } from "@/lib/constants/external-urls"
import { openExternal } from "@/lib/tauri/opener"

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
    <Card data-testid="about-whatsnew-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SparklesIcon className="size-4" />
          {t("whatsNew.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="single" collapsible defaultValue={latest}>
          {RELEASES.map((release) => (
            <AccordionItem key={release.version} value={release.version}>
              <AccordionTrigger data-testid={`whatsnew-trigger-${release.version}`}>
                <span className="flex items-center gap-2">
                  <span className="font-mono">{release.version}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {formatDate(release.date)}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {release.highlightKeys.map((key) => (
                    <li key={key}>{t(`whatsNew.highlights.${key}`)}</li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        <Button
          variant="link"
          size="sm"
          className="mt-1 h-8 px-0"
          onClick={() => void openExternal(RELEASES_URL)}
          data-testid="whatsnew-view-all"
        >
          {t("whatsNew.viewAll")}
        </Button>
      </CardContent>
    </Card>
  )
}
