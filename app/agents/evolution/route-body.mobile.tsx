"use client"

import { useTranslations } from "next-intl"
import { DnaIcon } from "lucide-react"
import { EmptyState } from "@/components/mobile/empty-state"
import type { RouteBodyProps } from "./route-body"

/**
 * Harness Evolution runs live in the desktop's local tables, next to the
 * probes that produce them; the phone build has neither, so the page says
 * where to look instead of showing an empty viewer.
 */
export default function RouteBody(_props: RouteBodyProps) {
  const t = useTranslations("harnessEvolution.page")
  return (
    <div
      className="flex h-full items-center justify-center p-6"
      data-testid="harness-run-page-mobile"
    >
      <EmptyState icon={DnaIcon} title={t("desktopOnlyTitle")} description={t("desktopOnlyBody")} />
    </div>
  )
}
