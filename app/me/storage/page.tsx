"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { StorageBreakdownCard } from "@/components/mobile/me/storage-breakdown-card"
import { StorageCleanupSheet } from "@/components/mobile/me/storage-cleanup-sheet"
import { StorageUsageCard } from "@/components/mobile/me/storage-usage-card"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileStoragePage() {
  const t = useTranslations("mobile.me")
  const tStorage = useTranslations("mobile.me.storage")
  const [cleanupOpen, setCleanupOpen] = useState(false)
  // Bump to force the breakdown card to remount (and re-fetch) after a cleanup.
  const [breakdownKey, setBreakdownKey] = useState(0)

  return (
    <SubPageShell
      title={t("storageRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-storage-page"
    >
      <div className="flex flex-col gap-3">
        <StorageUsageCard />
        <StorageBreakdownCard key={breakdownKey} />
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => setCleanupOpen(true)}
          data-testid="storage-cleanup-cta"
        >
          <Trash2Icon className="mr-2 size-4" aria-hidden="true" />
          {tStorage("cleanupCta")}
        </Button>
      </div>
      <StorageCleanupSheet
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        onCleaned={() => setBreakdownKey((k) => k + 1)}
      />
    </SubPageShell>
  )
}
