"use client"

import { useTranslations } from "next-intl"
import { MonitorIcon } from "lucide-react"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { filesRequiresDesktopOrWeb } from "@/lib/runtime/surface-contract"

/**
 * Files on the phone shell: deliberately dormant (see
 * `filesRequiresDesktopOrWeb`). The rail never offers it there; a deep link
 * lands here instead of on a page reading a database that is not the host's.
 */
export function FilesMobileUnsupported() {
  const t = useTranslations("files.unsupported")
  return (
    <main
      className="flex w-full min-w-0 flex-1 items-center justify-center p-6"
      data-testid="files-mobile-unsupported"
      data-dormant-reason={filesRequiresDesktopOrWeb.reason}
    >
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MonitorIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{t("title")}</EmptyTitle>
          <EmptyDescription>{t("description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  )
}
