"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"

import { installImNotifyWatcher } from "@/stores/chat/im-notify-store"

/**
 * Installs the IM-notify watcher for the app's lifetime: armed sessions ping
 * their bound IM conversation when a run settles (done / error / needs input).
 * Strings come from the React tree so the pushed titles follow the UI locale.
 */
export function ImNotifyInitializer() {
  const t = useTranslations("chat.imNotify")

  useEffect(
    () =>
      installImNotifyWatcher({
        done: (title) => t("done", { title }),
        error: (title) => t("error", { title }),
        attention: (title) => t("attention", { title }),
      }),
    [t]
  )

  return null
}
