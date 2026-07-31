"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ArchiveIcon, CheckIcon, CloudIcon, LaptopIcon, LoaderCircleIcon } from "lucide-react"

import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { switchAccountRuntimeTarget } from "@/lib/runtime/account-runtime-target"
import { RuntimeTargetRegistry, type RuntimeTargetRecord } from "@/lib/runtime/target-registry"
import { cn } from "@/lib/utils"
import { useAccountStore } from "@/stores/account/account-store"

interface RuntimeTargetMenuSectionProps {
  accountIdOverride?: string
  targetsOverride?: RuntimeTargetRecord[]
  activeTargetIdOverride?: string
  onSwitchOverride?: (accountId: string, targetId: string) => Promise<RuntimeTargetRecord>
  onSwitched?: () => void
}

export function RuntimeTargetMenuSection({
  accountIdOverride,
  targetsOverride,
  activeTargetIdOverride,
  onSwitchOverride = switchAccountRuntimeTarget,
  onSwitched,
}: RuntimeTargetMenuSectionProps) {
  const t = useTranslations("account.runtimeTarget")
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const snapshot = useRuntimeSnapshot()
  const accountId = accountIdOverride ?? unlockedAccountId
  const activeTargetId = activeTargetIdOverride ?? snapshot.target?.id
  const [loadedTargets, setLoadedTargets] = useState<RuntimeTargetRecord[]>([])
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (targetsOverride || !accountId || snapshot.target?.platform !== "web") return
    let cancelled = false
    const registry = new RuntimeTargetRegistry()
    void registry
      .listTargets(accountId)
      .then((rows) => {
        if (!cancelled) setLoadedTargets(rows)
      })
      .catch(() => {
        if (!cancelled) setError(t("loadFailed"))
      })
    return () => {
      cancelled = true
      registry.close()
    }
  }, [accountId, snapshot.target?.id, snapshot.target?.platform, t, targetsOverride])

  const targets =
    targetsOverride ?? (accountId && snapshot.target?.platform === "web" ? loadedTargets : [])
  if (!accountId || targets.length === 0) return null

  const switchTarget = async (targetId: string) => {
    if (targetId === activeTargetId || pendingTargetId) return
    setPendingTargetId(targetId)
    setError(null)
    try {
      await onSwitchOverride(accountId, targetId)
      onSwitched?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("switchFailed"))
    } finally {
      setPendingTargetId(null)
    }
  }

  return (
    <section aria-label={t("heading")} data-testid="runtime-target-menu">
      <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("heading")}
      </div>
      <div className="flex flex-col">
        {targets.map((target) => {
          const active = target.id === activeTargetId
          const pending = target.id === pendingTargetId
          const Icon =
            target.kind === "standalone"
              ? LaptopIcon
              : target.kind === "legacy-readonly"
                ? ArchiveIcon
                : target.hostKind === "cloud"
                  ? CloudIcon
                  : LaptopIcon
          const label =
            target.kind === "standalone"
              ? t("thisBrowser")
              : target.kind === "legacy-readonly"
                ? t("legacyMixed")
                : target.label
          return (
            <button
              key={target.id}
              type="button"
              disabled={active || pendingTargetId !== null}
              onClick={() => void switchTarget(target.id)}
              data-testid={`runtime-target-${target.id}`}
              className={cn(
                "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-70",
                active && "bg-primary/10 text-foreground"
              )}
            >
              {pending ? (
                <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
              ) : (
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {active && (
                <>
                  <span className="text-[10px] text-muted-foreground">{t("active")}</span>
                  <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />
                </>
              )}
            </button>
          )
        })}
      </div>
      {error && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
