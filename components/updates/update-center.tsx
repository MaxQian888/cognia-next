"use client"

/**
 * The Update Center.
 *
 * Grouped by who installs what, because that is the distinction users get
 * wrong: the app and the CLI are one kind of thing, browser extensions are
 * updated by the browser, and plugins and content are ours.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon } from "lucide-react"

import { CharacterPackUpdateDialog } from "@/components/settings/character-pack-update-dialog"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useUpdateCenter } from "@/hooks/updates/use-update-center"
import { subscribeUpdateCenterOpen } from "@/lib/updates/open-update-center"

import { UpdateRow } from "./update-row"

export interface UpdateCenterProps {
  /** Run a check as soon as the panel is shown. */
  autoCheck?: boolean
}

export function UpdateCenter({ autoCheck = false }: UpdateCenterProps) {
  const t = useTranslations("updates")
  const { groups, items, checking, check, apply, skip, defer, clearHold } = useUpdateCenter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  // A character pack is not installed by the coordinator: its action opens the
  // existing three-way diff, which is the only place user edits survive.
  const [packDiff, setPackDiff] = useState<{ id: string; name: string } | null>(null)

  useEffect(
    () =>
      subscribeUpdateCenterOpen((o) => {
        setFocusKey(o.focusKey ?? null)
        if (o.packDiffCharacterId) setPackDiff({ id: o.packDiffCharacterId, name: "" })
      }),
    []
  )

  useEffect(() => {
    if (!autoCheck) return
    void check(false)
  }, [autoCheck, check])

  const run = useCallback(async (key: string, fn: (key: string) => Promise<void>) => {
    setBusyKey(key)
    try {
      await fn(key)
    } finally {
      setBusyKey(null)
    }
  }, [])

  const applyRow = useCallback(
    async (key: string) => {
      const row = items.find((item) => item.key === key)
      if (row?.kind === "character-pack") {
        setPackDiff({ id: row.assetId, name: row.displayName ?? row.assetId })
        return
      }
      await run(key, (k) => apply(k, true))
    },
    [apply, items, run]
  )

  const lastChecked = items.reduce<number | undefined>(
    (acc, item) =>
      item.lastCheckedAt && (!acc || item.lastCheckedAt > acc) ? item.lastCheckedAt : acc,
    undefined
  )

  return (
    <div className="space-y-4" data-testid="update-center">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void check(true)} disabled={checking} data-testid="update-check-all">
          <RefreshCwIcon className={`me-2 size-4 ${checking ? "animate-spin" : ""}`} />
          {checking ? t("checking") : t("checkAll")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {lastChecked
            ? t("lastChecked", { when: new Date(lastChecked).toLocaleString() })
            : t("neverChecked")}
        </span>
      </div>

      {groups.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {t("nothingHere")}
        </p>
      )}

      {groups.map((group, index) => (
        <div key={group.group} className="space-y-2">
          {index > 0 && <Separator />}
          <div>
            <h3 className="text-sm font-medium">{t(`groups.${group.group}`)}</h3>
            <p className="text-xs text-muted-foreground">{t(`groupHint.${group.group}`)}</p>
          </div>
          <div className="space-y-2">
            {group.items.map((item) => (
              <UpdateRow
                key={item.key}
                item={item}
                busy={busyKey === item.key}
                highlighted={focusKey === item.key}
                onApply={(key) => void applyRow(key)}
                onSkip={(key) => void run(key, skip)}
                onDefer={(key) => void run(key, defer)}
                onClearHold={(key) => void run(key, clearHold)}
              />
            ))}
          </div>
        </div>
      ))}

      <CharacterPackUpdateDialog
        open={packDiff !== null}
        characterId={packDiff?.id ?? null}
        characterName={packDiff?.name ?? ""}
        onCancel={() => setPackDiff(null)}
        onConfirm={async () => {
          const id = packDiff?.id
          setPackDiff(null)
          if (!id) return
          const { applyPackUpdate } = await import("@/lib/db/characters")
          await applyPackUpdate(id)
          await check(false)
        }}
      />
    </div>
  )
}
