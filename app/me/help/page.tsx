"use client"

/**
 * Static help / documentation entry. Provides ext-link rows to the docs
 * site, GitHub repo, and a short legal/credits paragraph (mirrors the
 * pieces of `AboutSection` that are useful on a phone).
 */

import { useTranslations } from "next-intl"
import { BookOpenIcon, ExternalLinkIcon, CodeIcon, ScaleIcon } from "lucide-react"

import { MeRow } from "@/components/mobile/me/me-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

const DOCS_URL = "https://docs.cognia.app"
const GITHUB_URL = "https://github.com/anthropics/claude-code"

export default function MobileHelpPage() {
  const t = useTranslations("mobile.me")
  const tHelp = useTranslations("mobile.me.help")
  return (
    <SubPageShell title={t("helpRow")} backAria={t("appearanceBackAria")} testid="mobile-help-page">
      <div className="flex flex-col gap-4">
        <MeSection title={tHelp("resourcesTitle")} testid="help-section-resources">
          <MeRow
            icon={BookOpenIcon}
            label={tHelp("docsLabel")}
            description={tHelp("docsDescription")}
            value={<ExternalLinkIcon className="size-3.5" aria-hidden="true" />}
            href={DOCS_URL}
            testid="help-row-docs"
          />
          <MeRow
            icon={CodeIcon}
            label={tHelp("githubLabel")}
            description={tHelp("githubDescription")}
            value={<ExternalLinkIcon className="size-3.5" aria-hidden="true" />}
            href={GITHUB_URL}
            testid="help-row-github"
          />
        </MeSection>
        <MeSection title={tHelp("legalTitle")} testid="help-section-legal">
          <MeRow
            icon={ScaleIcon}
            label={tHelp("licenseLabel")}
            description={tHelp("licenseDescription")}
            testid="help-row-license"
          />
        </MeSection>
      </div>
    </SubPageShell>
  )
}
