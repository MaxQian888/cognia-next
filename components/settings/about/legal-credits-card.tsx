"use client"

import { useTranslations } from "next-intl"
import { ScaleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { COPYRIGHT_HOLDER, COPYRIGHT_START_YEAR, LICENSE_NAME } from "@/lib/app-metadata"
import { LICENSE_URL, PRIVACY_URL } from "@/lib/constants/external-urls"
import { openExternal } from "@/lib/tauri/opener"

import { AboutCard } from "./about-card"
import { InfoRow } from "./info-row"
import { TechStack } from "./tech-stack"

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
    <AboutCard icon={ScaleIcon} title={t("legal.title")} testid="about-legal-card">
      <p
        className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs text-pretty text-muted-foreground"
        data-testid="copyright-line"
      >
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

      <p className="mt-4 mb-2 text-xs font-medium text-muted-foreground">
        {t("legal.acknowledgements")}
      </p>
      <TechStack />
    </AboutCard>
  )
}
