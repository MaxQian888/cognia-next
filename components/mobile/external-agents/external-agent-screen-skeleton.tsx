"use client"

/**
 * The placeholder for an external-agent screen whose title and body both wait
 * on the URL (`?preset=`, `?id=`).
 *
 * In a static export `useSearchParams` suspends until the client has the URL,
 * so these pages put the whole screen, header included, under one Suspense
 * boundary. A `null` fallback flashed a blank screen with no back button; this
 * keeps the page's shape (header bar, a card, form rows) so nothing jumps when
 * the real screen arrives.
 */

import { useTranslations } from "next-intl"

import { Skeleton } from "@/components/ui/skeleton"

export function ExternalAgentScreenSkeleton({ testid }: { testid?: string }) {
  const t = useTranslations("mobile.externalAgents")
  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col bg-background safe-area-pt"
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      data-testid={testid ?? "external-agent-screen-skeleton"}
    >
      <div className="border-b px-3 py-2">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-2">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="h-5 w-40" />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    </main>
  )
}
