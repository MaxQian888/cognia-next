// The pet's command ids, alone and dependency-free.
//
// `lib/pet/commands.ts` registers these through the command registry, which
// drags the access gate, Dexie and the settings store along. The shortcut
// sheet (`components/settings/shortcuts-section.tsx`) only needs the ids to
// offer them as bindable rows, so they live here and both import one list:
// an id offered for binding is always an id that is registered.

/** The window toggle's command id (global hotkey, tray, ⌘K). */
export const PET_WINDOW_COMMAND_ID = "pet.toggle-window"

/** The nurture command ids, in their canonical order (the shortcut sheet lists them so). */
export const PET_INTERACTION_COMMAND_IDS = [
  "pet.feed",
  "pet.play",
  "pet.pet",
  "pet.sleep",
  "pet.clean",
  "pet.treat",
] as const

export type PetInteractionCommandId = (typeof PET_INTERACTION_COMMAND_IDS)[number]
