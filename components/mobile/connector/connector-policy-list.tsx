"use client"

/**
 * Mobile connector reply-policy list (Wave 2.8 wiring).
 *
 * Lists every enabled adapter instance with a one-line policy summary
 * (default mode / muted / quiet-hours window); tapping a row opens
 * `ConnectorPolicySheet`, which does the optimistic Dexie write and
 * enqueues the `adapter_update_policy` RPC for the desktop runner.
 * Mounted on `/me/connectors` above the shared `ConnectionsSection`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"

import { ConnectorPolicySheet, type ConnectorPolicy } from "./connector-policy-sheet"

export function ConnectorPolicyList() {
  const t = useTranslations("mobile.connectorPolicy")
  const [selected, setSelected] = useState<ConnectorPolicy | null>(null)
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(selected !== null, () => setSelected(null))

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb()
            .adapterInstances.filter((r) => r.enabled)
            .toArray(),
    []
  )

  const modeLabel = (mode: AdapterInstanceRow["defaultMode"]) =>
    mode === "manual" ? t("modeManual") : mode === "draft" ? t("modeDraft") : t("modeAuto")

  if (!adapters || adapters.length === 0) {
    // No enabled adapters → nothing to configure; the ConnectionsSection
    // below already carries the "add a connector" empty state.
    return null
  }

  return (
    <>
      <MeSection
        title={t("listTitle")}
        description={t("listDescription")}
        withSeparators
        testid="connector-policy-list"
      >
        {adapters.map((adapter) => (
          <Item
            key={adapter.id}
            size="sm"
            role="button"
            tabIndex={0}
            // The whole row, not a field-by-field copy. The copy silently
            // dropped every field it did not list, which is why the sheet's
            // activation controls were always seeded empty.
            onClick={() => setSelected(adapter)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                e.currentTarget.click()
              }
            }}
            className="cursor-pointer active:bg-muted/50"
            data-testid={`connector-policy-row-${adapter.id}`}
          >
            <ItemContent>
              <ItemTitle className="text-sm">{adapter.displayName}</ItemTitle>
              <ItemDescription className="flex flex-wrap items-center gap-1">
                <Badge variant="outline" className="text-[10px]">
                  {modeLabel(adapter.defaultMode)}
                </Badge>
                {adapter.muted ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("mutedBadge")}
                  </Badge>
                ) : null}
                {adapter.quietHours ? (
                  <span className="text-[11px] text-muted-foreground">
                    {adapter.quietHours.from}–{adapter.quietHours.to}
                  </span>
                ) : null}
              </ItemDescription>
            </ItemContent>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Item>
        ))}
      </MeSection>

      <ConnectorPolicySheet
        open={selected !== null}
        policy={selected}
        onOpenChange={(next) => {
          if (!next) setSelected(null)
        }}
      />
    </>
  )
}
