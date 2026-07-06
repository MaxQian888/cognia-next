"use client"

/**
 * Mobile GitHub Delivery page (ADR-0056, Wave 4). Read-only view of the
 * delivery bot's default policy (`DEFAULT_GH_POLICY`), with "manage on
 * desktop" guidance for everything that needs the desktop runtime.
 *
 * Paired-only (`<PairedOnly>`, decision D2): GitHub Delivery runs entirely on
 * the desktop / connector runtime — repo OAuth (`repos-tab` is `isTauri()`-
 * gated), the App-credential wizard, the live audit log (`github-delivery:audit`
 * plugin Dexie table) and `/rate_limit` usage polling all require the desktop
 * (the plugin is mobile-blocked, so those tables don't even exist on the phone).
 * The standalone phone has no delivery runtime, so this is paired-only.
 *
 * Read-only (decisions D6 + the "no new companion RPC" rule): the policy shown
 * here is the shipped default reference. Editing repos/credentials/policies and
 * viewing per-repo audit/usage stay "manage on desktop" — there is no mobile
 * write path and inventing one is out of scope.
 */

import { useTranslations } from "next-intl"
import { GitMergeIcon, MonitorSmartphoneIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { DEFAULT_GH_POLICY } from "@/lib/github/types"

function GithubDeliveryBody() {
  const t = useTranslations("mobile.githubDelivery")
  const p = DEFAULT_GH_POLICY

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="github-delivery-intro">
        {t("intro")}
      </p>

      <MeSection
        title={t("policy.title")}
        description={t("policy.description")}
        testid="me-section-github-delivery-policy"
      >
        <Item size="sm" className="px-0" data-testid="gh-policy-green-ci">
          <ItemContent>
            <ItemTitle className="text-xs">{t("policy.requireGreenCi")}</ItemTitle>
          </ItemContent>
          <Badge variant={p.requireGreenCi ? "default" : "outline"}>
            {p.requireGreenCi ? t("policy.required") : t("policy.off")}
          </Badge>
        </Item>
        <Item size="sm" className="px-0" data-testid="gh-policy-human-approval">
          <ItemContent>
            <ItemTitle className="text-xs">{t("policy.requireHumanApproval")}</ItemTitle>
          </ItemContent>
          <Badge variant={p.requireHumanApproval ? "default" : "outline"}>
            {p.requireHumanApproval ? t("policy.required") : t("policy.off")}
          </Badge>
        </Item>
        <Item size="sm" className="px-0" data-testid="gh-policy-max-merges">
          <ItemContent>
            <ItemTitle className="text-xs">{t("policy.maxDailyMerges")}</ItemTitle>
          </ItemContent>
          <Badge variant="secondary">{t("policy.perDay", { count: p.maxDailyMerges })}</Badge>
        </Item>
        <Item size="sm" className="px-0" data-testid="gh-policy-authors">
          <ItemContent>
            <ItemTitle className="text-xs">{t("policy.allowedAuthors")}</ItemTitle>
          </ItemContent>
          <Badge variant="outline">{p.allowedAuthors.kind}</Badge>
        </Item>
        <Item size="sm" className="px-0" data-testid="gh-policy-branches">
          <ItemContent>
            <ItemTitle className="text-xs">{t("policy.protectedBranches")}</ItemTitle>
            <ItemDescription className="flex flex-wrap gap-1 pt-1">
              {p.branchProtection.map((rgx) => (
                <Badge key={rgx} variant="secondary" className="font-mono text-[10px]">
                  {rgx}
                </Badge>
              ))}
            </ItemDescription>
          </ItemContent>
        </Item>
      </MeSection>

      <div
        className="flex items-start gap-3 rounded-xl border bg-card px-3 py-3 text-xs text-muted-foreground"
        data-testid="github-delivery-manage-note"
      >
        <MonitorSmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t("manageOnDesktop")}</p>
      </div>

      <div
        className="flex items-start gap-3 px-1 text-[11px] text-muted-foreground/80"
        data-testid="github-delivery-runtime-note"
      >
        <GitMergeIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>{t("runtimeNote")}</p>
      </div>
    </div>
  )
}

export default function MobileGithubDeliveryPage() {
  const t = useTranslations("mobile.githubDelivery")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-github-delivery-page">
      <PairedOnly>
        <GithubDeliveryBody />
      </PairedOnly>
    </SubPageShell>
  )
}
