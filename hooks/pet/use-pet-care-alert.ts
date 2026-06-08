// Main-window hook that turns the controller's "became unwell" store signal into
// a gentle Notification Center entry. Lives in React (not the controller) so it
// has the i18n context; the controller stays i18n-free. Fires at most once per
// episode (the signal's `at` changes per transition; recovery resets it).

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useSettingsStore } from "@/stores/settings"
import { usePetStore } from "@/stores/pet/pet-store"
import { notifyBecameUnwell } from "@/lib/pet/care/notify-care"

/**
 * Watch the transient care-alert signal and post the gentle "your pet isn't
 * feeling great" notification. Gated by `enabled` (main window only) and the
 * `careAlerts` setting (default on).
 */
export function usePetCareAlert(enabled: boolean): void {
  const t = useTranslations("pet")
  const careAlertsSetting = useSettingsStore((s) => s.settings?.petSettings?.careAlerts)
  const careAlert = usePetStore((s) => s.careAlert)
  const setCareAlert = usePetStore((s) => s.setCareAlert)
  const handledAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !careAlert) return
    if (handledAtRef.current === careAlert.at) return
    handledAtRef.current = careAlert.at

    if (careAlertsSetting === false) {
      // Alerts muted — drain the signal without notifying.
      setCareAlert(null)
      return
    }

    const name = careAlert.petName
    void notifyBecameUnwell({
      title: t("care.unwell.title"),
      body: name ? t("care.unwell.body", { name }) : t("care.unwell.bodyNoName"),
    }).finally(() => setCareAlert(null))
  }, [enabled, careAlert, careAlertsSetting, setCareAlert, t])
}
