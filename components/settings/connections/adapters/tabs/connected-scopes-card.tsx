"use client"

/**
 * Read-only "Access" card for the adapter detail — surfaces the OAuth scopes
 * this connector was actually granted (persisted by the platform OAuth
 * handlers via `recordGrantedScopes`). Renders nothing for adapters that never
 * recorded scopes (non-OAuth platforms, or not yet connected). Scope changes
 * on re-authorization are surfaced in the Audit tab (`oauth.scope_changed`);
 * this card is the at-a-glance "what is this connector allowed to do".
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ConnectedScopes } from "@/lib/connectors/oauth-scope-audit"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export interface ConnectedScopesCardProps {
  row: AdapterInstanceRow
}

export function ConnectedScopesCard({ row }: ConnectedScopesCardProps) {
  const t = useTranslations("settings.connections.adapters.scopes")
  const connected = row.settings.connectedScopes as ConnectedScopes | undefined
  if (!connected || connected.scopes.length === 0) return null

  return (
    <Card data-testid="connected-scopes-card">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <p className="text-muted-foreground">
          {t("grantedAt", { date: new Date(connected.grantedAtMs).toLocaleString() })}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {connected.scopes.map((scope) => (
            <li key={scope}>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {scope}
              </Badge>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">{t("readOnlyHint")}</p>
      </CardContent>
    </Card>
  )
}
