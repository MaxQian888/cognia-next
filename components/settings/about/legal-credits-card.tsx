"use client"

import { useTranslations } from "next-intl"
import { ScaleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { COPYRIGHT_HOLDER, COPYRIGHT_START_YEAR, LICENSE_NAME } from "@/lib/app-metadata"
import { LICENSE_URL, PRIVACY_URL } from "@/lib/constants/external-urls"
import { openExternal } from "@/lib/tauri/opener"

import { InfoRow } from "./info-row"

/** Proper-noun project names — not translated. */
const ACKNOWLEDGEMENTS: { name: string; url: string }[] = [
  { name: "Next.js", url: "https://nextjs.org" },
  { name: "React", url: "https://react.dev" },
  { name: "Tauri", url: "https://tauri.app" },
  { name: "Capacitor", url: "https://capacitorjs.com" },
  { name: "Tailwind CSS", url: "https://tailwindcss.com" },
  { name: "shadcn/ui", url: "https://ui.shadcn.com" },
  { name: "Radix UI", url: "https://www.radix-ui.com" },
  { name: "Zustand", url: "https://zustand-demo.pmnd.rs" },
  { name: "next-intl", url: "https://next-intl.dev" },
]

/**
 * Legal + credits: copyright line, licence, privacy policy, and open-source
 * acknowledgements (tech-stack badges). The repo has no licence file yet, so
 * when {@link LICENSE_NAME} is null we show only the repo licence link.
 */
export function LegalCreditsCard({ currentYear }: { currentYear?: number } = {}) {
  const t = useTranslations("settings.about")
  const year = currentYear ?? new Date().getFullYear()
  const copyrightRange =
    year > COPYRIGHT_START_YEAR ? `${COPYRIGHT_START_YEAR}–${year}` : `${COPYRIGHT_START_YEAR}`

  return (
    <Card data-testid="about-legal-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScaleIcon className="size-4" />
          {t("legal.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground" data-testid="copyright-line">
          {t("legal.copyright", { year: copyrightRange, holder: COPYRIGHT_HOLDER })}
        </p>

        <div className="mt-2">
          <InfoRow
            label={t("legal.license")}
            value={
              <span className="inline-flex items-center gap-2">
                {LICENSE_NAME && <span className="font-mono">{LICENSE_NAME}</span>}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => void openExternal(LICENSE_URL)}
                  data-testid="view-license"
                >
                  {t("legal.viewLicense")}
                </Button>
              </span>
            }
            testid="row-license"
          />
          <InfoRow
            label={t("legal.privacy")}
            value={
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => void openExternal(PRIVACY_URL)}
                data-testid="view-privacy"
              >
                {t("legal.viewPrivacy")}
              </Button>
            }
            testid="row-privacy"
          />
        </div>

        <Separator className="my-3" />

        <p className="mb-2 text-xs font-medium">{t("legal.acknowledgements")}</p>
        <div className="flex flex-wrap gap-1.5" data-testid="acknowledgements">
          {ACKNOWLEDGEMENTS.map(({ name, url }) => (
            <Badge key={name} variant="outline" asChild className="cursor-pointer hover:bg-accent">
              <button type="button" onClick={() => void openExternal(url)}>
                {name}
              </button>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
