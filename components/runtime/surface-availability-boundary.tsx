"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, LockKeyholeIcon, WifiOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
      <>
        <div
          role="status"
          className="border-b border-border bg-muted/60 px-4 py-2 text-xs text-muted-foreground"
        >
          {t("readOnly", { reason: t(`reasons.${availability.reason}`) })}
        </div>
        {children}
      </>
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
      <section
        aria-labelledby="surface-unavailable-title"
        className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-sm"
      >
        <Icon aria-hidden className="mb-4 size-8 text-muted-foreground" />
        <h1 id="surface-unavailable-title" className="text-lg font-semibold">
          {t(`states.${availability.state}`)}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t(`reasons.${availability.reason}`)}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {recovery && (
            <Button asChild>
              <Link href={recovery.href}>{t(recovery.label)}</Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/">{t("backToChat")}</Link>
          </Button>
        </div>
      </section>
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
