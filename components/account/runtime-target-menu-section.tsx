"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  CheckIcon,
  CloudIcon,
  LaptopIcon,
  LoaderCircleIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"

import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { switchAccountRuntimeTarget } from "@/lib/runtime/account-runtime-target"
import { removeCompanionHost } from "@/lib/companion/host-removal"
import { switchCompanionHost } from "@/lib/companion/host-orchestration"
import { RuntimeTargetRegistry, type RuntimeTargetRecord } from "@/lib/runtime/target-registry"
import { cn } from "@/lib/utils"
import { useAccountStore } from "@/stores/account/account-store"

interface RuntimeTargetMenuSectionProps {
  accountIdOverride?: string
  targetsOverride?: RuntimeTargetRecord[]
  activeTargetIdOverride?: string
  onSwitchOverride?: (accountId: string, targetId: string) => Promise<RuntimeTargetRecord>
  onRemoveOverride?: typeof removeCompanionHost
  onSwitched?: () => void
  /**
   * Render nothing unless at least one *companion* target exists. Every web
   * account has a standalone target, so without this the section would appear
   * on a browser that has never paired — a one-row list of the target it is
   * already on. Callers that already describe the current target (the runtime
   * connection popover) pass this so the list appears only when it offers a
   * real choice.
   */
  requireCompanion?: boolean
  /** Hide the built-in "Add host" row for callers that offer their own. */
  showAddHost?: boolean
  /**
   * Applied to the root. Callers that need a divider must put it here rather
   * than beside the element: this component renders `null` in several cases,
   * and a sibling `<Separator />` would survive as a stray rule over nothing.
   */
  className?: string
}

export function RuntimeTargetMenuSection({
  accountIdOverride,
  targetsOverride,
  activeTargetIdOverride,
  onSwitchOverride,
  onRemoveOverride = removeCompanionHost,
  onSwitched,
  requireCompanion = false,
  showAddHost = true,
  className,
}: RuntimeTargetMenuSectionProps) {
  const t = useTranslations("account.runtimeTarget")
  const router = useRouter()
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
  if (requireCompanion && !targets.some((target) => target.kind === "companion")) return null

  const switchTarget = async (targetId: string) => {
    if (targetId === activeTargetId || pendingTargetId) return
    setPendingTargetId(targetId)
    setError(null)
    try {
      const target = targets.find((candidate) => candidate.id === targetId)
      if (!target) throw new Error(t("switchFailed"))
      if (onSwitchOverride) {
        await onSwitchOverride(accountId, targetId)
      } else if (target.kind === "companion") {
        await switchCompanionHost({ accountId, hostId: targetId, platform: "web" })
      } else {
        await switchAccountRuntimeTarget(accountId, targetId)
      }
      onSwitched?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("switchFailed"))
    } finally {
      setPendingTargetId(null)
    }
  }

  const removeTarget = async (target: RuntimeTargetRecord) => {
    if (!accountId || pendingTargetId || target.kind !== "companion") return
    if (!window.confirm(t("removeConfirm", { name: target.label }))) return
    const companionAlternatives = targets.filter(
      (candidate) => candidate.kind === "companion" && candidate.id !== target.id
    )
    let fallbackHostId: string | undefined
    if (target.id === activeTargetId && companionAlternatives.length > 0) {
      const choices = companionAlternatives.map((candidate) => candidate.id).join(", ")
      const selected = window.prompt(t("fallbackPrompt", { choices }), companionAlternatives[0].id)
      if (!selected) return
      if (!companionAlternatives.some((candidate) => candidate.id === selected)) {
        setError(t("fallbackInvalid"))
        return
      }
      fallbackHostId = selected
    }
    setPendingTargetId(target.id)
    setError(null)
    try {
      await onRemoveOverride({
        accountId,
        hostId: target.id,
        platform: "web",
        ...(fallbackHostId ? { fallbackHostId } : {}),
      })
      if (!targetsOverride) {
        const registry = new RuntimeTargetRegistry()
        try {
          setLoadedTargets(await registry.listTargets(accountId))
        } finally {
          registry.close()
        }
      }
      onSwitched?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("removeFailed"))
    } finally {
      setPendingTargetId(null)
    }
  }

  return (
    <section aria-label={t("heading")} data-testid="runtime-target-menu" className={className}>
      <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("heading")}
      </div>
      {showAddHost ? (
        <button
          type="button"
          onClick={() => router.push("/pair?mode=add")}
          className="mx-2 mb-1 flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
        >
          <PlusIcon aria-hidden className="size-4" />
          {t("addHost")}
        </button>
      ) : null}
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
            <div key={target.id} className="flex items-stretch">
              <button
                type="button"
                disabled={active || pendingTargetId !== null}
                onClick={() => void switchTarget(target.id)}
                data-testid={`runtime-target-${target.id}`}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-70",
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
              {target.kind === "companion" ? (
                <button
                  type="button"
                  disabled={pendingTargetId !== null}
                  aria-label={t("removeHost", { name: target.label })}
                  data-testid={`runtime-target-remove-${target.id}`}
                  className="rounded px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void removeTarget(target)}
                >
                  <Trash2Icon aria-hidden className="size-4" />
                </button>
              ) : null}
            </div>
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
