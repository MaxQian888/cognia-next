/**
 * Ask the shell to open the pet console, optionally on a named tab.
 *
 * `PetMount` already routes the popup window's open-console request through
 * the cross-window bridge, because only the main window holds the app router.
 * Callers inside the main window had no way to say the same thing without
 * importing the router, which a tool runner and a command handler cannot do.
 *
 * A DOM event on `window`, matching `lib/shell/command-palette-request.ts`: no
 * store, and no import cycle between the console and the things that open it.
 */

import type { PetConsoleTab } from "@/lib/pet/console-tabs"

export const PET_CONSOLE_REQUEST_EVENT = "cognia:pet-console:request"

export interface PetConsoleRequestDetail {
  /** Open on this tab. Omitted opens the console's default tab. */
  tab?: PetConsoleTab
}

export function requestPetConsole(detail: PetConsoleRequestDetail = {}): boolean {
  if (typeof window === "undefined") return false
  window.dispatchEvent(new CustomEvent(PET_CONSOLE_REQUEST_EVENT, { detail }))
  return true
}

/** Subscribe the shell. Returns the unsubscribe. */
export function onPetConsoleRequest(
  handler: (detail: PetConsoleRequestDetail) => void
): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PetConsoleRequestDetail>).detail
    handler(detail && typeof detail === "object" ? detail : {})
  }
  window.addEventListener(PET_CONSOLE_REQUEST_EVENT, listener)
  return () => window.removeEventListener(PET_CONSOLE_REQUEST_EVENT, listener)
}
