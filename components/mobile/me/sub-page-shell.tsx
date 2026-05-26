"use client"

/**
 * Shared chrome for every `/me/<section>` sub-page.
 *
 * Renders a sticky header with a back button (always returns to `/me`)
 * + page title, applies the iOS / Android safe-area top padding, wraps
 * the body in `Suspense` with a skeleton fallback, and constrains the
 * scroll container to the viewport. Identical structure to the original
 * `app/me/appearance/page.tsx` — extracted here so the 14 new sub-pages
 * stay in lock-step.
 */

import { Suspense, type ReactNode } from "react"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export interface SubPageShellProps {
  title: string
  /** Localised label for the back arrow (announced by screen readers). */
  backAria: string
  /** Where back navigates to. Defaults to `/me`. */
  backHref?: string
  /** Right-aligned slot in the header — useful for status pills. */
  headerAccessory?: ReactNode
  children: ReactNode
  /** Body padding override. Defaults to `px-4 py-4`. */
  bodyClassName?: string
  /** Custom Suspense fallback. Defaults to a 3-block Skeleton. */
  fallback?: ReactNode
  testid?: string
}

function DefaultFallback() {
  return (
    <div className="space-y-4 px-4 py-3" aria-busy="true">
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

export function SubPageShell({
  title,
  backAria,
  backHref = "/me",
  headerAccessory,
  children,
  bodyClassName,
  fallback,
  testid,
}: SubPageShellProps) {
  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background safe-area-pt"
      data-testid={testid}
    >
      <header className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-2">
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label={backAria}
            data-testid="mobile-sub-page-back"
          >
            <Link href={backHref}>
              <ArrowLeftIcon className="size-5" aria-hidden="true" />
            </Link>
          </Button>
          <h1 className="flex-1 truncate text-base font-semibold tracking-tight">{title}</h1>
          {headerAccessory ? <div className="shrink-0">{headerAccessory}</div> : null}
        </div>
      </header>
      <section className={cn("mx-auto w-full max-w-2xl px-4 py-4", bodyClassName)}>
        <Suspense fallback={fallback ?? <DefaultFallback />}>{children}</Suspense>
      </section>
    </main>
  )
}
