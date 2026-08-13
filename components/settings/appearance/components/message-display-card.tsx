"use client"

import { useSettingsStore } from "@/stores/settings"
import { MessageDisplayControls } from "./message-display-controls"

export function MessageDisplayCard() {
  const value = useSettingsStore((state) => state.settings?.messageDisplay)
  const save = useSettingsStore((state) => state.save)

  return (
    <MessageDisplayControls
      value={value ?? { preset: "balanced" }}
      onChange={(messageDisplay) =>
        void save({ messageDisplay: messageDisplay ?? { preset: "balanced" } })
      }
    />
  )
}
