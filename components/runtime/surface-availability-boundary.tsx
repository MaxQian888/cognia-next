"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, LockKeyholeIcon, WifiOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import {
  getSurfaceContractForRoute,
  isInternalRouteExempt,
  resolveSurfaceAvailability,
} from "@/lib/runtime/surface-contract"

export function SurfaceAvailabilityBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const snapshot = useRuntimeSnapshot()
  const t = useTranslations("runtime.surfaceBoundary")
  const contract = getSurfaceContractForRoute(pathname)

  if (!contract || isInternalRouteExempt(pathname) || !snapshot.target) {
    return <>{children}</>
  }

  const availability = resolveSurfaceAvailability(contract, snapshot)
  if (availability.state === "available" || availability.state === "queued") {
    return <>{children}</>
  }
  if (availability.state === "read-only") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Alert
          role="status"
          className="shrink-0 rounded-none border-x-0 border-t-0 bg-muted/60 py-2"
        >
          <AlertDescription className="text-xs">
            {t("readOnly", { reason: t(`reasons.${availability.reason}`) })}
          </AlertDescription>
        </Alert>
        {children}
      </div>
    )
  }

  const recovery = recoveryForState(availability.state)
  const Icon =
    availability.state === "offline"
      ? WifiOffIcon
      : availability.state === "requires-unlock"
        ? LockKeyholeIcon
        : AlertTriangleIcon

  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6">
      <Empty
        aria-labelledby="surface-unavailable-title"
        className="w-full max-w-lg rounded-none border-x-0 border-y py-8"
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon aria-hidden />
          </EmptyMedia>
          <h1 id="surface-unavailable-title" className="text-lg font-semibold tracking-tight">
            {t(`states.${availability.state}`)}
          </h1>
          <EmptyDescription>{t(`reasons.${availability.reason}`)}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {recovery && (
            <Button asChild>
              <Link href={recovery.href}>{t(recovery.label)}</Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/">{t("backToChat")}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}

function recoveryForState(
  state: ReturnType<typeof resolveSurfaceAvailability>["state"]
): { href: string; label: "pairHost" | "unlockVault" | "diagnose" } | null {
  if (state === "requires-pairing" || state === "unsupported") {
    return { href: "/pair", label: "pairHost" }
  }
  if (state === "requires-unlock") {
    return { href: "/me/profile", label: "unlockVault" }
  }
  if (state === "requires-grant" || state === "incompatible") {
    return { href: "/me/diagnostics", label: "diagnose" }
  }
  return null
}
