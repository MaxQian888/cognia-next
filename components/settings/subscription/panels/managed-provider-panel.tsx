"use client"

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { getAllProviders } from "@cognia/provider-types/provider"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAccounts } from "@/lib/subscription/core/hooks"
import type { SubscriptionProviderDefinition } from "@/lib/subscription/core/provider-registry"
import { providerSettingsHref } from "@/lib/settings/deep-link"
import { isTauri } from "@/lib/tauri"
import { ManagedKeyAccountDialog } from "../add-account-dialog/managed-key"
import { PresetPicker } from "../preset-picker"
import { ProviderQuotaPanel } from "../provider-quota-panel"

/** Registered providers share one account, quota, and connection management surface. */
export function ManagedProviderPanel({
  provider,
  onManageAccounts,
}: {
  provider: SubscriptionProviderDefinition
  onManageAccounts: () => void
}) {
  const t = useTranslations("subscription.managedProvider")
  const { accounts, activeAccountId, loading, error, reload } = useAccounts(provider.id)
  const [adding, setAdding] = useState(false)
  const subscription = provider.billingMode === "subscription"
  const active = accounts.find((account) => account.id === activeAccountId)
  const catalog = getAllProviders()
  const canManage = isTauri() && provider.available !== false
  const usageBase = provider.usage?.baseUrl ?? provider.baseUrl
  const usageDestination =
    provider.usage && usageBase
      ? `${provider.usage.request.useBaseUrlOrigin ? new URL(usageBase).origin : usageBase.replace(/\/$/, "")}${provider.usage.request.path}`
      : null

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ProviderIcon
            providerId={provider.brandId ?? provider.id}
            label={provider.name}
            size={24}
          />
          <h3 className="text-sm font-semibold">{provider.name}</h3>
          {provider.billingMode && (
            <Badge variant="secondary">{t(subscription ? "subscriptionBadge" : "paygBadge")}</Badge>
          )}
        </div>
        {provider.description && (
          <p className="text-xs text-muted-foreground">{provider.description}</p>
        )}
        {provider.billingMode && (
          <p className="text-xs text-muted-foreground">
            {t(subscription ? "subscriptionDescription" : "paygDescription")}
          </p>
        )}
      </div>
      <div className="space-y-3 rounded-md border p-3">
        <h4 className="text-sm font-medium">{t("accountsTitle")}</h4>
        <p className="text-xs text-muted-foreground">
          {loading
            ? t("loadingAccounts")
            : error
              ? t("accountsUnavailable")
              : active
                ? t("activeAccount", {
                    account: active.label || active.email || t("unnamedAccount"),
                  })
                : t("noActiveAccount")}
        </p>
        {!loading && !error && (
          <p className="text-xs text-muted-foreground">
            {t("accountCount", { count: accounts.length })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onManageAccounts}>
            {t("manageAccounts")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)} disabled={!canManage}>
            {t("addAccount")}
          </Button>
        </div>
        {!isTauri() && <p className="text-xs text-muted-foreground">{t("desktopRequired")}</p>}
      </div>
      <dl className="space-y-2 text-xs">
        {provider.baseUrl && (
          <div>
            <dt className="text-muted-foreground">{t("inferenceDestination")}</dt>
            <dd className="break-all font-mono">{provider.baseUrl}</dd>
          </div>
        )}
        {usageDestination && (
          <div>
            <dt className="text-muted-foreground">{t("usageDestination")}</dt>
            <dd className="break-all font-mono">{usageDestination}</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap gap-3 text-xs text-primary">
        <Link
          href={providerSettingsHref({ provider: provider.id })}
          scroll={false}
          className="underline-offset-4 hover:underline"
        >
          {t("openProvider")}
        </Link>
        {subscription &&
          provider.relatedProviderIds
            ?.filter((id) => catalog[id])
            .map((id) => (
              <Link
                key={id}
                href={providerSettingsHref({ provider: id })}
                scroll={false}
                className="underline-offset-4 hover:underline"
              >
                {t("openPaygProvider", { name: catalog[id].name })}
              </Link>
            ))}
        {(
          [
            ["getKey", provider.apiKeyUrl],
            ["usageConsole", provider.usageUrl],
            ["docs", provider.docsUrl],
          ] as const
        ).map(
          ([label, url]) =>
            url && (
              <a
                key={label}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-4 hover:underline"
              >
                {t(label)}
              </a>
            )
        )}
      </div>
      {provider.usage ? (
        <ProviderQuotaPanel provider={provider.id} />
      ) : (
        <p className="text-xs text-muted-foreground">{t("quotaUnavailable")}</p>
      )}
      {!subscription && <PresetPicker provider={provider.id} />}
      {adding && canManage && (
        <ManagedKeyAccountDialog
          definition={provider}
          open
          onOpenChange={setAdding}
          onAdded={() => {
            void reload().catch(() => undefined)
          }}
        />
      )}
    </div>
  )
}
