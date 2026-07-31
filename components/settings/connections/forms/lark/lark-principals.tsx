"use client"

/**
 * Feishu identity registry admin card (plan 2026-07-24 P1.1).
 *
 * The desktop/browser half of the two operator channels over
 * `lib/connectors/principal/admin.ts` — `cognia lark …` is the headless half.
 * Without this card the registry is unusable: an unbound sender is answered
 * with a bind code and there is nowhere to approve it, so turning
 * `larkPrincipalRegistry` on would park every message forever.
 *
 * The tenant scope shown here is the one the ADAPTER authenticated as
 * (`lastWhoamiResult`), never operator-typed — a mistyped tenant key would
 * create a registry entry no event can ever match.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { getDb } from "@/lib/db/schema"
import {
  approveFeishuBind,
  registerFeishuTenant,
  rejectFeishuBind,
  setFeishuPrincipalEnabled,
  setFeishuTenantEnabled,
} from "@/lib/connectors/principal/admin"
import type {
  AdapterInstanceRow,
  FeishuPrincipalBindRequestRow,
  FeishuPrincipalRow,
  FeishuTenantRow,
} from "@/lib/db/connector-types"

const PRINCIPAL_BADGE_VARIANT: Record<
  FeishuPrincipalRow["status"],
  "default" | "secondary" | "outline"
> = {
  active: "default",
  disabled: "secondary",
  unlinked: "outline",
}

export interface LarkPrincipalsProps {
  adapterId: string
}

export function LarkPrincipals({ adapterId }: LarkPrincipalsProps) {
  const t = useTranslations("settings.connections.lark.principals")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  const tenantKey = row?.lastWhoamiResult?.tenantKey
  const appId = row?.lastWhoamiResult?.appId

  const tenant = useLiveQuery<FeishuTenantRow | undefined>(
    () =>
      typeof window === "undefined" || !tenantKey || !appId
        ? Promise.resolve(undefined)
        : getDb().feishuTenants.where("[tenantKey+appId]").equals([tenantKey, appId]).first(),
    [tenantKey, appId]
  )

  const requests =
    useLiveQuery<FeishuPrincipalBindRequestRow[]>(
      () =>
        typeof window === "undefined"
          ? Promise.resolve([])
          : getDb()
              .feishuPrincipalBindRequests.where("status")
              .equals("pending")
              .filter((request) => request.adapterId === adapterId)
              .toArray(),
      [adapterId]
    ) ?? []

  const principals =
    useLiveQuery<FeishuPrincipalRow[]>(
      () =>
        typeof window === "undefined" || !tenantKey || !appId
          ? Promise.resolve([])
          : getDb()
              .feishuPrincipals.where("[tenantKey+appId]")
              .equals([tenantKey, appId])
              .toArray(),
      [tenantKey, appId]
    ) ?? []

  /**
   * Every mutation reports its own failure instead of rejecting into an
   * unhandled promise — an operator who cannot see WHY an approval failed
   * will retry it forever.
   */
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-testid="lark-principals">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">{t("help")}</p>

        <div className="space-y-2">
          <Label className="text-xs">{t("tenantLabel")}</Label>
          {!tenantKey || !appId ? (
            <p className="text-xs text-muted-foreground italic" data-testid="lark-tenant-unknown">
              {t("tenantUnknown")}
            </p>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs break-all">
                {tenantKey} · {appId}
              </span>
              {tenant ? (
                <span className="flex items-center gap-1.5">
                  <Badge variant={tenant.status === "active" ? "default" : "secondary"}>
                    {t(`tenantStatus.${tenant.status}`)}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        setFeishuTenantEnabled({
                          adapterId,
                          tenantKey,
                          appId,
                          enabled: tenant.status !== "active",
                        })
                      )
                    }
                    data-testid="lark-tenant-toggle"
                  >
                    {tenant.status === "active" ? t("tenantDisable") : t("tenantEnable")}
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(() => registerFeishuTenant({ adapterId, tenantKey, appId }))
                  }
                  data-testid="lark-tenant-register"
                >
                  {t("tenantRegister")}
                </Button>
              )}
            </div>
          )}
          {tenantKey && appId && !tenant && (
            <p className="text-xs text-muted-foreground">{t("tenantUnregistered")}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs">{t("requestsLabel")}</Label>
          {requests.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">{t("requestsEmpty")}</p>
          ) : (
            <ul className="space-y-1.5">
              {requests.map((request) => (
                <li
                  key={request.id}
                  className="flex items-center justify-between gap-2 text-xs"
                  data-testid={`lark-bind-request-${request.id}`}
                >
                  <span className="font-mono break-all">{request.id}</span>
                  <span className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      aria-label={t("requestApproveAria", { code: request.id })}
                      onClick={() => void run(() => approveFeishuBind({ code: request.id }))}
                      data-testid={`lark-bind-approve-${request.id}`}
                    >
                      {t("requestApprove")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={t("requestRejectAria", { code: request.id })}
                      onClick={() => void run(() => rejectFeishuBind(request.id))}
                      data-testid={`lark-bind-reject-${request.id}`}
                    >
                      {t("requestReject")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs">{t("principalsLabel")}</Label>
          {principals.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">{t("principalsEmpty")}</p>
          ) : (
            <ul className="space-y-1.5">
              {principals.map((principal) => (
                <li
                  key={principal.id}
                  className="flex items-center justify-between gap-2 text-xs"
                  data-testid={`lark-principal-${principal.id}`}
                >
                  <span className="font-mono break-all">{principal.openId}</span>
                  <span className="flex items-center gap-1.5">
                    <Badge
                      variant={PRINCIPAL_BADGE_VARIANT[principal.status]}
                      aria-label={t("principalStatusAria")}
                    >
                      {t(`principalStatus.${principal.status}`)}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          setFeishuPrincipalEnabled({
                            adapterId,
                            principalId: principal.id,
                            status: principal.status === "active" ? "disabled" : "active",
                          })
                        )
                      }
                      data-testid={`lark-principal-toggle-${principal.id}`}
                    >
                      {principal.status === "active" ? t("principalDisable") : t("principalEnable")}
                    </Button>
                    {principal.status !== "unlinked" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            setFeishuPrincipalEnabled({
                              adapterId,
                              principalId: principal.id,
                              status: "unlinked",
                            })
                          )
                        }
                        data-testid={`lark-principal-unlink-${principal.id}`}
                      >
                        {t("principalUnlink")}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p className="text-xs text-destructive" role="status" data-testid="lark-principals-error">
            {t("actionFailed", { reason: error })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
