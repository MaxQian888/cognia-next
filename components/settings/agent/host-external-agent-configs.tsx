"use client"

/**
 * External agents the HOST owns, as seen from this client.
 *
 * The sibling panel above this one lists agents configured in *this* browser's
 * local store. They look similar and are not the same thing: a local agent can
 * only run where its process can be spawned, so on a browser it is a
 * configuration with nowhere to go. These rows live on the paired host, which
 * is also what runs them — which is why this panel can show a readiness verdict
 * at all, and the local one cannot promise one.
 *
 * The panel is rendered whenever a host is reachable, including when that host
 * is too old to serve it. Hiding it there would collapse three different
 * situations — no host paired, host still handshaking, host too old — into an
 * absence the user cannot act on.
 */

import { useTranslations } from "next-intl"
import { Loader2, RefreshCw, ServerCog, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
import { LifecycleStatusNotice } from "@/components/agent/external-agent/lifecycle-status-notice"
import { useHostExternalAgentConfigs } from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { HostConfigsUnavailableReason } from "@/lib/ai/agent/external/remote-host-configs"

const UNAVAILABLE_KEY: Record<HostConfigsUnavailableReason, string> = {
  "no-host": "unavailableNoHost",
  unsupported: "unavailableUnsupported",
  "manifest-missing": "unavailableManifestMissing",
}

function HostConfigRow({
  record,
  busy,
  onToggle,
  onRemove,
}: {
  record: ExternalAgentConfigRecord
  busy: boolean
  onToggle: (next: boolean) => void
  onRemove: () => void
}) {
  const t = useTranslations("externalAgent.hostConfigs")
  // No cast: `record.config` is a `StoredExternalAgentConfig`, which already
  // types `name`, `protocol` and the lifecycle fields read below.
  const config = record.config
  const notReady = record.lifecycleStatus !== "ready"

  return (
    <Item variant="outline">
      <ItemContent className="min-w-0">
        {/* `min-w-0` on the content, not on the title: the title's own
            intrinsic width is what defeats truncation inside an Item. */}
        <ItemTitle className="min-w-0 truncate">{config.name ?? record.configId}</ItemTitle>
        <ItemDescription className="flex flex-wrap items-center gap-2">
          {config.protocol ? <Badge variant="outline">{config.protocol}</Badge> : null}
          {/* The revision is what a run is admitted against, so it is the one
              piece of bookkeeping worth showing: it is what a "someone else
              edited this" conflict will name. */}
          <span className="font-mono text-xs">{t("revision", { seq: record.seq })}</span>
        </ItemDescription>
        <LifecycleStatusNotice
          status={record.lifecycleStatus}
          reasonCode={record.config.lifecycleReasonCode}
          className="mt-2"
        />
      </ItemContent>
      <ItemActions className="gap-1">
        <Switch
          checked={record.enabled}
          // A config the host says cannot run must not be switchable on: the
          // host would refuse the write, and offering the control implies a
          // choice the user does not have. The notice above says why.
          disabled={busy || notReady}
          onCheckedChange={onToggle}
          aria-label={t("toggleLabel", { name: config.name ?? record.configId })}
        />
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          onClick={onRemove}
          aria-label={t("deleteLabel", { name: config.name ?? record.configId })}
        >
          <Trash2 className="size-4" />
        </Button>
      </ItemActions>
    </Item>
  )
}

export function HostExternalAgentConfigs() {
  const t = useTranslations("externalAgent.hostConfigs")
  const { configs, loading, unavailable, error, reconcile, setEnabled, remove, busy } =
    useHostExternalAgentConfigs()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerCog className="size-4" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {unavailable ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerCog />
              </EmptyMedia>
              <EmptyTitle>{t("unavailableTitle")}</EmptyTitle>
              <EmptyDescription>{t(UNAVAILABLE_KEY[unavailable])}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-sm">
                {t("count", { count: configs.length })}
              </span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void reconcile()}>
                <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
                {t("recheck")}
              </Button>
            </div>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            {configs.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
                  <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-2">
                {configs.map((record) => (
                  <HostConfigRow
                    key={record.configId}
                    record={record}
                    busy={busy}
                    onToggle={(next) => void setEnabled(record, next)}
                    onRemove={() => void remove(record)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
