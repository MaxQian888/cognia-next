"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftRightIcon, CheckIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/mobile/empty-state"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { impact } from "@/lib/capacitor/haptics"
import {
  companionCredentialBook,
  type CompanionHostRecord,
} from "@/lib/companion/credential-book"
import { removeCompanionHost } from "@/lib/companion/host-removal"
import { switchCompanionHost } from "@/lib/companion/host-orchestration"

export interface MobilePairedServersSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export interface MobileHostEntry {
  hostId: string
  label: string
  detail: string
  active: boolean
  lastSeenAt: number | null
}

export function mobileHostEntries(
  records: CompanionHostRecord[],
  activeHostId: string | null
): MobileHostEntry[] {
  return records
    .map((record) => ({
      hostId: record.hostId,
      label: record.label,
      detail: record.endpoints.baseUrl.replace(/^https?:\/\//, ""),
      active: record.hostId === activeHostId,
      lastSeenAt: record.connection.lastOkAt,
    }))
    .sort((left, right) => Number(right.active) - Number(left.active) || left.label.localeCompare(right.label))
}

export function MobilePairedServersSheet({ open, onOpenChange }: MobilePairedServersSheetProps) {
  const t = useTranslations("mobile.connectionState.switch")
  const router = useRouter()
  const guard = useBiometricGuard()
  useBackDismiss(open, () => onOpenChange(false))
  const [hosts, setHosts] = useState<CompanionHostRecord[]>([])
  const [activeHostId, setActiveHostId] = useState<string | null>(null)
  const [pendingHostId, setPendingHostId] = useState<string | null>(null)
  const [removeCandidate, setRemoveCandidate] = useState<CompanionHostRecord | null>(null)
  const [fallbackHostId, setFallbackHostId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(0)

  const loadHosts = useCallback(async () => {
    const book = companionCredentialBook()
    const [records, active] = await Promise.all([
      book.list(DEFAULT_LOCAL_ACCOUNT_ID),
      book.getActive(DEFAULT_LOCAL_ACCOUNT_ID),
    ])
    setHosts(records)
    setActiveHostId(active?.hostId ?? null)
    setNow(Date.now())
  }, [])

  useEffect(() => {
    if (!open) return
    const initialLoad = window.setTimeout(() => {
      void loadHosts().catch(() => setError(t("loadFailed")))
    }, 0)
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      clearTimeout(initialLoad)
      clearInterval(timer)
    }
  }, [loadHosts, open, t])

  const entries = mobileHostEntries(hosts, activeHostId)
  const fallbackOptions = hosts.filter((host) => host.hostId !== removeCandidate?.hostId)

  const handleSwitch = async (entry: MobileHostEntry) => {
    if (entry.active || pendingHostId) return
    setPendingHostId(entry.hostId)
    setError(null)
    try {
      await switchCompanionHost({
        accountId: DEFAULT_LOCAL_ACCOUNT_ID,
        hostId: entry.hostId,
        platform: "mobile",
      })
      await loadHosts()
      void impact("light")
      toast.success(t("switchedTo", { name: entry.label }))
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("switchFailed"))
    } finally {
      setPendingHostId(null)
    }
  }

  const beginRemoval = (record: CompanionHostRecord) => {
    const firstFallback = hosts.find((host) => host.hostId !== record.hostId)?.hostId ?? ""
    setFallbackHostId(firstFallback)
    setRemoveCandidate(record)
    setError(null)
  }

  const confirmRemoval = async () => {
    if (!removeCandidate || pendingHostId) return
    const removingSoleHost = hosts.length === 1
    setPendingHostId(removeCandidate.hostId)
    setError(null)
    try {
      const outcome = await guard(
        {
          reason: t("removeReason"),
          title: t("removeTitle", { name: removeCandidate.label }),
          description: t("removeDescription"),
        },
        () =>
          removeCompanionHost({
            accountId: DEFAULT_LOCAL_ACCOUNT_ID,
            hostId: removeCandidate.hostId,
            fallbackHostId: fallbackHostId || undefined,
            platform: "mobile",
          })
      )
      if (outcome.kind === "blocked") {
        if (outcome.reason !== "cancelled") setError(t("biometricFailed", { reason: outcome.reason }))
        return
      }
      toast.success(t("removed", { name: removeCandidate.label }))
      setRemoveCandidate(null)
      await loadHosts()
      if (removingSoleHost) router.replace("/pair")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("removeFailed"))
    } finally {
      setPendingHostId(null)
    }
  }

  const formatLastSeen = (timestamp: number | null): string => {
    if (!timestamp) return t("never")
    const difference = now - timestamp
    if (difference < 60_000) return t("justNow")
    if (difference < 3_600_000) return t("minutesAgo", { n: Math.floor(difference / 60_000) })
    if (difference < 86_400_000) return t("hoursAgo", { n: Math.floor(difference / 3_600_000) })
    return t("daysAgo", { n: Math.floor(difference / 86_400_000) })
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[70dvh] gap-0 p-0" data-testid="mobile-paired-servers-sheet">
          <SheetHeader className="px-4 pt-4">
            <SheetTitle className="flex items-center gap-2 text-base">
              <ArrowLeftRightIcon className="size-4" aria-hidden="true" />
              {t("title")}
            </SheetTitle>
          </SheetHeader>
          <div className="flex items-center justify-end px-4 py-2">
            <Button size="sm" variant="outline" onClick={() => router.push("/pair?mode=add")}>
              <PlusIcon className="size-4" aria-hidden="true" />
              {t("addHost")}
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
            {entries.length === 0 ? (
              <EmptyState icon={ServerIcon} title={t("empty")} />
            ) : (
              <ul className="flex flex-col gap-2" data-testid="mobile-paired-servers-list">
                {entries.map((entry) => (
                  <li key={entry.hostId} className="flex items-stretch gap-1.5">
                    <Button
                      variant="outline"
                      disabled={entry.active || pendingHostId !== null}
                      className="h-auto min-w-0 flex-1 justify-between gap-3 py-3 text-left"
                      onClick={() => void handleSwitch(entry)}
                      data-testid={`mobile-paired-row-${entry.hostId}`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                        <span className="flex items-center gap-1 truncate text-sm font-semibold">
                          {pendingHostId === entry.hostId
                            ? t("switchingTo", { name: entry.label })
                            : entry.label}
                          {entry.active ? <CheckIcon className="size-3 text-primary" aria-label={t("active")} /> : null}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground">{entry.detail}</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {t("lastSeen")}: {formatLastSeen(entry.lastSeenAt)}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-auto shrink-0 text-muted-foreground"
                      aria-label={t("remove", { name: entry.label })}
                      onClick={() => beginRemoval(hosts.find((host) => host.hostId === entry.hostId)!)}
                      data-testid={`mobile-paired-remove-${entry.hostId}`}
                    >
                      <Trash2Icon className="size-4" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={removeCandidate !== null} onOpenChange={(next) => !next && setRemoveCandidate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeTitle", { name: removeCandidate?.label ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          {removeCandidate?.hostId === activeHostId && fallbackOptions.length > 0 ? (
            <label className="space-y-1 text-sm">
              <span>{t("fallbackLabel")}</span>
              <NativeSelect value={fallbackHostId} onChange={(event) => setFallbackHostId(event.target.value)} wrapperClassName="w-full">
                {fallbackOptions.map((host) => <NativeSelectOption key={host.hostId} value={host.hostId}>{host.label}</NativeSelectOption>)}
              </NativeSelect>
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmRemoval()} disabled={pendingHostId !== null}>
              {t("confirmRemove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
