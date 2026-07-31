"use client"

/**
 * Title-bar quick-actions cluster — one-click access to the desktop pet,
 * screen OCR, and content capture. Each control reuses an existing entry
 * point: the pet toggle drives `usePetStore.setMinimized`; OCR and capture
 * open their settings surfaces (capture is configured in the pet console)
 * via the shared `requestOpenSettings` request. Gated by the parent
 * (`barItems.quickActions`).
 */

import { useTranslations } from "next-intl"
import { ClipboardIcon, PawPrintIcon, ScanTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { usePetStore } from "@/stores/pet/pet-store"
import { useUIStore } from "@/stores/ui/ui-store"

function QuickButton({
  label,
  testId,
  active,
  onClick,
  children,
}: {
  label: string
  testId: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 w-7 rounded-sm text-muted-foreground transition-colors hover:text-foreground",
        "motion-safe:transition-transform motion-safe:active:scale-90",
        active ? "text-foreground" : undefined
      )}
    >
      {children}
    </Button>
  )
}

export function TitleBarQuickActions({ className }: { className?: string }) {
  const t = useTranslations("desktop.titleBar.quickActions")
  const minimized = usePetStore((s) => s.minimized)
  const setMinimized = usePetStore((s) => s.setMinimized)
  const requestOpenSettings = useUIStore((s) => s.requestOpenSettings)

  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
      data-testid="title-bar-quick-actions"
    >
      <QuickButton
        label={minimized ? t("showPet") : t("hidePet")}
        testId="quick-action-pet"
        active={!minimized}
        onClick={() => setMinimized(!minimized)}
      >
        <PawPrintIcon className="size-4" aria-hidden />
      </QuickButton>
      <QuickButton
        label={t("ocr")}
        testId="quick-action-ocr"
        onClick={() => requestOpenSettings("ocr")}
      >
        <ScanTextIcon className="size-4" aria-hidden />
      </QuickButton>
      <QuickButton
        label={t("capture")}
        testId="quick-action-capture"
        onClick={() => requestOpenSettings("pet")}
      >
        <ClipboardIcon className="size-4" aria-hidden />
      </QuickButton>
    </div>
  )
}
