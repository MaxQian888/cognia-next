// Mobile runtime mode — paired (companion → desktop sidecar) vs standalone
// (BYOK, in-webview inference). The mode is a device-local setting chosen during
// onboarding (`AppSettings.mobileRuntimeMode`); `undefined` means "not chosen
// yet" and the mobile onboarding shows the chooser.
//
// `isStandaloneChatMode()` is the hot-path predicate the chat send/stop branches
// read to decide between the standalone engine and the companion transport. It
// is synchronous (reads the in-memory settings store) so it can run inline in
// `use-claude-chat.send`.

import { isCapacitor } from "@/lib/platform/detect"
import { useSettingsStore } from "@/stores/settings/settings-store"

export type MobileRuntimeMode = "paired" | "standalone"

/** The chosen mobile runtime mode, or `undefined` when not yet selected. */
export function getMobileRuntimeMode(): MobileRuntimeMode | undefined {
  return useSettingsStore.getState().settings?.mobileRuntimeMode
}

/** Persist the mobile runtime mode (onboarding chooser / settings toggle). */
export async function setMobileRuntimeMode(mode: MobileRuntimeMode): Promise<void> {
  await useSettingsStore.getState().save({ mobileRuntimeMode: mode })
}

/**
 * True when chat/search/documents should run standalone in the webview against
 * the user's own provider keys — i.e. the Capacitor shell with mode=standalone.
 * Off the Capacitor shell (desktop/web) this is always false.
 */
export function isStandaloneChatMode(): boolean {
  return isCapacitor() && getMobileRuntimeMode() === "standalone"
}
