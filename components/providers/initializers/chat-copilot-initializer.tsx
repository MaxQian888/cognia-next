"use client"

/**
 * Main-window half of the desktop chat copilot (ADR-0194 §8): registers the
 * `chat-copilot.capture` command (bound to a shortcut in Settings → Shortcuts,
 * listed in the tray's command menu) and runs the controller that drives the
 * `chat-copilot` overlay. Mounted from `DesktopOnlyInitializers`, so it exists
 * only in the main desktop window: the web and mobile shells cannot read other
 * apps' windows, and Settings → Automation says so there.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { desktop } from "@/lib/automation/client"
import {
  CONSENT_REQUEST_EVENT,
  claimConsentSurface,
  consentPromptOf,
  markConsentSettled,
} from "@/lib/automation/consent-routing"
import type { ConsentRequestEvent } from "@/lib/automation/client"
import { registerCommand } from "@/lib/plugin/commands/registry"
import { createScreenCopilotController } from "@/lib/reply-copilot/screen/controller"
import {
  CHAT_COPILOT_COMMAND_ID,
  closeChatCopilotOverlay,
  onChatCopilotIntent,
  openChatCopilotOverlay,
  placeChatCopilotOverlay,
  sendChatCopilotView,
} from "@/lib/reply-copilot/screen/overlay-client"
import { draftForScreen, readChatScreen } from "@/lib/reply-copilot/screen/run-screen-copilot"
import { transport } from "@/lib/tauri"
import { repairSelectionToolbarPermission } from "@/lib/tauri/selection-toolbar"
import { useSettingsStore } from "@/stores/settings"

export function ChatCopilotInitializer() {
  const t = useTranslations("chatCopilot")
  // The controller outlives renders; read the latest translator through a ref.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    const controller = createScreenCopilotController({
      settings: () => useSettingsStore.getState().settings,
      read: (settings, options) => readChatScreen(settings, options),
      draft: (read, settings, options) => draftForScreen(read, settings, options),
      overlay: {
        open: openChatCopilotOverlay,
        place: placeChatCopilotOverlay,
        close: closeChatCopilotOverlay,
        send: sendChatCopilotView,
      },
      consent: {
        subscribe: (handler) =>
          transport.subscribe<ConsentRequestEvent>(CONSENT_REQUEST_EVENT, handler),
        respond: (args) => desktop.consentRespond(args),
        promptOf: consentPromptOf,
        claim: () => claimConsentSurface("chatCopilot"),
        settle: markConsentSettled,
      },
      openScreenRecordingSettings: () => repairSelectionToolbarPermission("screenRecording"),
      onOverlayUnavailable: () => toast.error(tRef.current("overlayUnavailable")),
      now: () => Date.now(),
    })

    let disposed = false
    let offIntent: (() => void) | null = null
    void onChatCopilotIntent((intent) => void controller.handleIntent(intent)).then((off) => {
      if (disposed) off()
      else offIntent = off
    })
    const unregister = registerCommand({
      id: CHAT_COPILOT_COMMAND_ID,
      title: tRef.current("command.title"),
      category: "chat",
      pluginId: null,
      handler: () => controller.start(),
    })

    return () => {
      disposed = true
      offIntent?.()
      unregister()
      controller.dispose()
    }
  }, [])

  return null
}
