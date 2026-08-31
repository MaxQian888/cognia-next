"use client"

/**
 * One external service, with its connection methods as child rows.
 *
 * Split out of `external-services-section.tsx` because the section previously
 * rendered a service twice, in two different vocabularies: once as an
 * "available" card that listed provider kinds and offered nothing, and once
 * as one flat connection row per provider whose only control was Pause. A
 * service like Figma, which declares two interchangeable MCP providers,
 * therefore appeared as two unrelated rows reading "pending" with no way to
 * act on either.
 *
 * The state and next step come from `lib/external-services/service-view.ts`.
 * This file only decides how they look, which is why every branch below is a
 * lookup rather than a condition.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, PauseIcon, PlayIcon, ShieldCheckIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { mcpHref } from "@/lib/settings/deep-link"
import { cn } from "@/lib/utils"
import type { ServiceProviderView, ServiceView } from "@/lib/external-services/service-view"

export interface ServiceCardProps {
  service: ServiceView
  /** Pause or resume the connection behind one provider row. */
  onToggleProvider: (provider: ServiceProviderView) => void
}

export function ServiceCard({ service, onToggleProvider }: ServiceCardProps) {
  const t = useTranslations("settings.externalServices")

  return (
    <Card data-testid={`external-service-${service.serviceId}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          {service.icon ? (
            <span
              aria-hidden
              className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md text-lg"
            >
              {service.icon}
            </span>
          ) : null}
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              <span className="truncate">{service.label}</span>
              {service.connected ? (
                <Badge data-testid={`external-service-${service.serviceId}-connected`}>
                  {t("status.connected")}
                </Badge>
              ) : service.awaitingReview ? (
                <Badge
                  variant="outline"
                  className="gap-1"
                  data-testid={`external-service-${service.serviceId}-review`}
                >
                  <ShieldCheckIcon className="size-3" />
                  {t("status.pending")}
                </Badge>
              ) : null}
            </CardTitle>
            {service.description ? (
              <p className="text-muted-foreground text-xs">{service.description}</p>
            ) : null}
            {service.skillIds.length > 0 ? (
              <p className="text-muted-foreground text-[11px]">
                {t("services.skills", { count: service.skillIds.length })}
              </p>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {t("services.providersLabel")}
        </p>
        {service.providers.map((provider) => (
          <ProviderRow
            key={provider.providerId}
            service={service}
            provider={provider}
            onToggle={() => onToggleProvider(provider)}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function ProviderRow({
  service,
  provider,
  onToggle,
}: {
  service: ServiceView
  provider: ServiceProviderView
  onToggle: () => void
}) {
  const t = useTranslations("settings.externalServices")
  const label = provider.connection?.accountLabel ?? provider.providerId
  const stateLabel =
    provider.state === "not-connected"
      ? t("services.state.not-connected")
      : t(`status.${provider.state}` as "status.pending")
  const testId = `external-service-provider-${service.serviceId}-${provider.providerId}`

  // The hint explains a state the user cannot otherwise interpret. `pending` on
  // a managed MCP row does not mean "connecting", it means "waiting on you".
  const hint =
    provider.action.kind === "review"
      ? t("services.reviewHint")
      : provider.action.kind === "blocked-upstream"
        ? t("services.blockedUpstreamHint")
        : null

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5"
      data-testid={testId}
      data-state={provider.state}
      data-action={provider.action.kind}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm">{label}</span>
          <Badge variant="outline" className="text-[10px]">
            {t(`services.providerKind.${provider.kind}` as "services.providerKind.mcp")}
          </Badge>
          {provider.availability !== "supported" ? (
            <Badge variant="secondary" className="text-[10px]">
              {t(`availability.${provider.availability}` as "availability.preview")}
            </Badge>
          ) : null}
          <Badge
            variant={provider.state === "connected" ? "default" : "outline"}
            className={cn("text-[10px]", provider.state === "suspended" && "opacity-70")}
          >
            {stateLabel}
          </Badge>
        </div>
        {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
        {provider.connection ? (
          <div className="flex flex-wrap gap-1">
            {provider.connection.enabledSurfaces.map((surface) => (
              <Badge key={surface} variant="outline" className="text-[10px]">
                {t(`surface.${surface}` as "surface.chat")}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <PrimaryAction provider={provider} testId={`${testId}-primary`} />
        {provider.connection ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            data-testid={`${testId}-toggle`}
            aria-label={provider.state === "suspended" ? t("actions.resume") : t("actions.pause")}
          >
            {provider.state === "suspended" ? (
              <PlayIcon className="size-3.5" />
            ) : (
              <PauseIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The row's one next step.
 *
 * `review` and `manage` both lead to the MCP section rather than duplicating
 * the trust flow here. A managed server is created disabled and untrusted on
 * purpose, and `reviewMcpServer` deliberately does not enable anything, so a
 * "Connect" button here would either lie or quietly widen what the plugin can
 * do without the user seeing the tool list.
 */
function PrimaryAction({ provider, testId }: { provider: ServiceProviderView; testId: string }) {
  const t = useTranslations("settings.externalServices")
  const { action } = provider

  if (action.kind === "review" || action.kind === "manage") {
    return (
      <Button
        asChild
        size="sm"
        variant={action.kind === "review" ? "default" : "outline"}
        data-testid={testId}
      >
        <Link href={mcpHref({ server: action.serverId })}>
          <ExternalLinkIcon className="size-3.5" />
          {t(action.kind === "review" ? "services.action.review" : "services.action.manage")}
        </Link>
      </Button>
    )
  }

  if (action.kind === "blocked-upstream") {
    return (
      <Button size="sm" variant="outline" disabled data-testid={testId}>
        {t("services.action.blockedUpstream")}
      </Button>
    )
  }

  // `resume` is already offered by the toggle beside this slot, and `none`
  // has nothing to offer. Rendering a second disabled button for either would
  // be noise.
  return null
}
