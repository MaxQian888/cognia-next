// The companion wire names for remote pet care (ADR-0219).
//
// One list, read by both halves: the host's dispatch family
// (`host-dispatch.ts`, delegated from `lib/companion/desktop-write-source.ts`)
// and the paired device's typed client (`client.ts`). The contract itself
// lives in `protocol/companion-commands.json`; `commands.test.ts` holds this
// list equal to the `pet_*` descriptors there, so a command added on one side
// only fails a test instead of answering `unknown desktop-write command`.

export const PET_REMOTE_COMMANDS = {
  get: "pet_get",
  act: "pet_act",
  rename: "pet_rename",
  itemPurchase: "pet_item_purchase",
  itemApply: "pet_item_apply",
  soulGenerate: "pet_soul_generate",
  chatSend: "pet_chat_send",
  chatList: "pet_chat_list",
  chatClear: "pet_chat_clear",
} as const

export type PetRemoteCommand = (typeof PET_REMOTE_COMMANDS)[keyof typeof PET_REMOTE_COMMANDS]

export const PET_REMOTE_COMMAND_NAMES: readonly PetRemoteCommand[] =
  Object.values(PET_REMOTE_COMMANDS)

const NAME_SET: ReadonlySet<string> = new Set(PET_REMOTE_COMMAND_NAMES)

export function isPetRemoteCommand(command: string): command is PetRemoteCommand {
  return NAME_SET.has(command)
}

/**
 * The commands that change the host pet. Never part of
 * `MOBILE_OUTBOUND_COMMANDS`: a care action replayed from an offline queue
 * would be answering a moment that has passed (the cooldown, the mood, the
 * coins it was priced against), so a paired device calls these live or not at
 * all.
 */
export const PET_REMOTE_WRITE_COMMANDS: readonly PetRemoteCommand[] = [
  PET_REMOTE_COMMANDS.act,
  PET_REMOTE_COMMANDS.rename,
  PET_REMOTE_COMMANDS.itemPurchase,
  PET_REMOTE_COMMANDS.itemApply,
  PET_REMOTE_COMMANDS.soulGenerate,
  PET_REMOTE_COMMANDS.chatSend,
  PET_REMOTE_COMMANDS.chatClear,
]
