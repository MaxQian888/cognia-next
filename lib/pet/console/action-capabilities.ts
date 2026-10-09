// What the /pet console can do in each of its two modes (ADR-0219).
//
// The pet lives on the desktop. The console runs `local` in the desktop app's
// main window, where it drives the pet controller directly, and `remote` on a
// paired phone or browser, where it reads a mirror of the pet tables and sends
// every action to the desktop over `pet_*` RPCs.
//
// Remote care covers the care loop: nurture, shop, inventory, hatch, rename,
// chat and the records (journal, dex, achievements). Some of the console works
// with things that exist only on the desktop and stays there on purpose:
//
//   - Customize: skins, Live2D models and sprite packs are device-local blobs,
//     and the size sliders shape a desktop window.
//   - Insights: the radar reads the desktop's capture sources and activity.
//   - Plugins: `pet.console.tab` extensions are the desktop's plugins.
//   - Character binding edits, the customization reset, the "on the desktop"
//     toggle and the skin retry/configure actions: each one writes desktop
//     settings or desktop-only assets that no `pet_*` arm carries.
//
// That is intentional dormancy, labelled on all three axes (CLAUDE.md rule 7):
//
//  1. **Type**: this table is the one place a capability is classified, and
//     `petConsoleCapability` is how every caller asks.
//  2. **UI**: in remote mode the desktop-only tabs stay in the nav with a
//     "Desktop" badge and render `components/pet/console/desktop-only-notice.tsx`,
//     the binding tab is read-only, and the desktop toggle becomes a status
//     chip (`components/pet/console/pet-console.tsx`).
//  3. **Test**: pinned by `lib/pet/console/action-capabilities.test.ts` and
//     `components/pet/console/pet-console.remote.test.tsx`.
//
// A desktop running the console locally has every capability; only `remote`
// consults the table.

import type { PetConsoleTab } from "@/lib/pet/console-tabs"

export type PetConsoleMode = "local" | "remote"

/** Whether a console capability runs in this mode, or only on the desktop. */
export type PetConsoleCapability = "available" | "desktop-only"

export const PET_CONSOLE_CAPABILITY_IDS = [
  // Tabs.
  "tab.nurture",
  "tab.chat",
  "tab.shop",
  "tab.customize",
  "tab.binding",
  "tab.insights",
  "tab.journal",
  "tab.dex",
  "tab.achievements",
  "tab.plugins",
  // Actions.
  "care",
  "shop.purchase",
  "item.use",
  "item.applyDecor",
  "rename",
  "hatch",
  "chat.send",
  "chat.clear",
  /** Turning pet chat (LLM speak) on: a desktop setting. */
  "chat.enable",
  "binding.edit",
  "reset",
  "desktop.toggle",
  "skin.retry",
  "skin.configure",
] as const

export type PetConsoleCapabilityId = (typeof PET_CONSOLE_CAPABILITY_IDS)[number]

/** How each capability behaves in remote mode. Local mode has every one. */
export const PET_CONSOLE_CAPABILITIES: Readonly<
  Record<PetConsoleCapabilityId, PetConsoleCapability>
> = Object.freeze({
  "tab.nurture": "available",
  "tab.chat": "available",
  "tab.shop": "available",
  "tab.customize": "desktop-only",
  // The tab opens; its edit controls are `binding.edit`, which is not.
  "tab.binding": "available",
  "tab.insights": "desktop-only",
  "tab.journal": "available",
  "tab.dex": "available",
  "tab.achievements": "available",
  "tab.plugins": "desktop-only",
  care: "available",
  "shop.purchase": "available",
  "item.use": "available",
  "item.applyDecor": "available",
  rename: "available",
  hatch: "available",
  "chat.send": "available",
  "chat.clear": "available",
  "chat.enable": "desktop-only",
  "binding.edit": "desktop-only",
  reset: "desktop-only",
  "desktop.toggle": "desktop-only",
  "skin.retry": "desktop-only",
  "skin.configure": "desktop-only",
})

export function petConsoleCapability(
  mode: PetConsoleMode,
  id: PetConsoleCapabilityId
): PetConsoleCapability {
  if (mode === "local") return "available"
  return PET_CONSOLE_CAPABILITIES[id]
}

/** The capability that opens a console tab. */
export function petConsoleTabCapability(tab: PetConsoleTab): PetConsoleCapabilityId {
  return `tab.${tab}`
}

/** Tabs that render the desktop-only notice instead of their panel in `mode`. */
export function petConsoleDesktopOnlyTabs(
  mode: PetConsoleMode,
  tabs: readonly PetConsoleTab[]
): ReadonlySet<PetConsoleTab> {
  return new Set(
    tabs.filter(
      (tab) => petConsoleCapability(mode, petConsoleTabCapability(tab)) === "desktop-only"
    )
  )
}
