"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { CreditCard } from "lucide-react"
import { getAllProviders } from "@cognia/provider-types/provider"
import { Badge } from "@/components/ui/badge"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { useAccounts } from "@/lib/subscription/core/hooks"
import type { SubscriptionProviderDefinition } from "@/lib/subscription/core/provider-registry"

const PAYG_PROVIDER_IDS = new Set(["moonshot", "zhipu", "minimax"])
const linkClassName = "text-xs text-primary underline-offset-4 hover:underline"

function SubscriptionAccountStatus({ providerId }: { providerId: string }) {
  const t = useTranslations("providers.subscriptionLinks")
  const { accounts, activeAccountId, loading, error } = useAccounts(providerId)
  const active = accounts.find((account) => account.id === activeAccountId)
  const status = loading
    ? t("loadingAccounts")
    : error
      ? t("accountsUnavailable")
      : active
        ? t("activeAccount", { account: active.label || active.email || t("unnamedAccount") })
        : t("noActiveAccount")
  return <p className="text-xs text-muted-foreground">{status}</p>
}

/** Cross-links keep credentials in the selected subscription's vault and billing source. */
export function SubscriptionProviderLinks({
  providerId,
  providers,
}: {
  providerId: string
  providers: readonly SubscriptionProviderDefinition[]
}) {
  const t = useTranslations("providers.subscriptionLinks")
  const searchParams = useSearchParams()
  const available = providers.filter((provider) => provider.available !== false)
  const current = available.find(
    (provider) => provider.id === providerId && provider.billingMode === "subscription"
  )
  const linked = current
    ? [current]
    : available.filter(
        (provider) =>
          provider.billingMode === "subscription" &&
          provider.relatedProviderIds?.includes(providerId)
      )
  if (!current && linked.length === 0 && !PAYG_PROVIDER_IDS.has(providerId)) return null

  const href = (section: "subscription" | "ai-connections", id: string) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const key of ["provider", "subTab", "innerTab", "focus"]) next.delete(key)
    next.set("section", section)
    next.set(section === "subscription" ? "subTab" : "provider", id)
    return `/settings?${next.toString()}`
  }
  const catalog = getAllProviders()

  return (
    <SettingsBlock
      icon={<CreditCard />}
      title={t("title")}
      description={t(current ? "subscriptionDescription" : "paygDescription")}
      badge={<Badge variant="secondary">{t(current ? "subscriptionBadge" : "paygBadge")}</Badge>}
    >
      <div className="space-y-4">
        {linked.map((provider) => (
          <div key={provider.id} className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderIcon
                providerId={provider.brandId ?? provider.id}
                label={provider.name}
                size={24}
              />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">{provider.name}</p>
                <SubscriptionAccountStatus providerId={provider.id} />
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              {!current && (
                <Link
                  href={href("ai-connections", provider.id)}
                  className={linkClassName}
                  scroll={false}
                >
                  {t("openProvider")}
                </Link>
              )}
              <Link
                href={href("subscription", provider.id)}
                className={linkClassName}
                scroll={false}
              >
                {t("openSubscription")}
              </Link>
            </div>
          </div>
        ))}
        {current && (
          <div className="flex flex-wrap gap-3">
            <Link href={href("subscription", "accounts")} className={linkClassName} scroll={false}>
              {t("manageAccounts")}
            </Link>
            {current.relatedProviderIds
              ?.filter((id) => catalog[id])
              .map((id) => (
                <Link
                  key={id}
                  href={href("ai-connections", id)}
                  className={linkClassName}
                  scroll={false}
                >
                  {t("openPaygProvider", { name: catalog[id].name })}
                </Link>
              ))}
          </div>
        )}
      </div>
    </SettingsBlock>
  )
}
