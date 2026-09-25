"use client"

/**
 * Title-bar quick-actions cluster — one-click access to the desktop pet,
 * screen OCR, and content capture. Each control reuses an existing entry
 * point: the pet toggle drives `usePetStore.setMinimized`; OCR opens its
 * settings section via the shared `requestOpenSettings` request; capture opens
 * the pet console's Insights tab, which is the only place
 * `CaptureSettingsPanel` is mounted (it used to open Settings → Pet, which has
 * no capture controls). Gated by the parent (`barItems.quickActions`).
 *
 * The pet and capture controls are desktop-shell only, like the pet itself
 * (ADR-0058 D9): the title bar also renders in the web shell, where the widget
 * never mounts and the pet console only explains that. The pet toggle further
 * needs the pet switched on, because it hides and shows a widget that only
 * exists then.
 */

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { ClipboardIcon, PawPrintIcon, ScanTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"
import { usePetStore } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui/ui-store"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

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
  const petEnabled = useSettingsStore(
    (s) => (s.settings?.petSettings ?? DEFAULT_PET_SETTINGS).enabled
  )
  const router = useRouter()
  const desktopShell = usePlatform() === "tauri"

  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
      data-testid="title-bar-quick-actions"
    >
      {desktopShell && petEnabled ? (
        <QuickButton
          label={minimized ? t("showPet") : t("hidePet")}
          testId="quick-action-pet"
          active={!minimized}
          onClick={() => setMinimized(!minimized)}
        >
          <PawPrintIcon className="size-4" aria-hidden />
        </QuickButton>
      ) : null}
      <QuickButton
        label={t("ocr")}
        testId="quick-action-ocr"
        onClick={() => requestOpenSettings("ocr")}
      >
        <ScanTextIcon className="size-4" aria-hidden />
      </QuickButton>
      {desktopShell ? (
        <QuickButton
          label={t("capture")}
          testId="quick-action-capture"
          onClick={() => router.push("/pet?tab=insights")}
        >
          <ClipboardIcon className="size-4" aria-hidden />
        </QuickButton>
      ) : null}
    </div>
  )
}
