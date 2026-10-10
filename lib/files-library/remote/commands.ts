// The companion wire names for the Files library on a paired device
// (ADR-0223 §9).
//
// One list, read by both halves: the host's dispatch family
// (`host-dispatch.ts`, delegated from `lib/companion/desktop-write-source.ts`)
// and the paired device's typed client (`client.ts`). The contract itself is
// `protocol/companion-commands.json`; `commands.test.ts` holds this list equal
// to the `files.library` descriptors there, so a command added on one side
// fails a test instead of answering `unknown desktop-write command`.

export const FILES_REMOTE_COMMANDS = {
  list: "files_library_list",
  folderList: "files_library_folder_list",
  search: "files_library_search",
  get: "files_library_get",
  readChunk: "files_library_read_chunk",
  favorite: "files_library_favorite",
  move: "files_library_move",
  trash: "files_library_trash",
  restore: "files_library_restore",
  purge: "files_library_purge",
  touch: "files_library_touch",
  rename: "files_library_rename",
  duplicate: "files_library_duplicate",
  attach: "files_library_attach",
  folderCreate: "files_library_folder_create",
  folderRename: "files_library_folder_rename",
  folderMove: "files_library_folder_move",
  folderStyle: "files_library_folder_style",
  folderDelete: "files_library_folder_delete",
  uploadInit: "files_library_upload_init",
  uploadChunk: "files_library_upload_chunk",
  uploadCommit: "files_library_upload_commit",
  uploadAbort: "files_library_upload_abort",
} as const

export type FilesRemoteCommand = (typeof FILES_REMOTE_COMMANDS)[keyof typeof FILES_REMOTE_COMMANDS]

export const FILES_REMOTE_COMMAND_NAMES: readonly FilesRemoteCommand[] =
  Object.values(FILES_REMOTE_COMMANDS)

const NAME_SET: ReadonlySet<string> = new Set(FILES_REMOTE_COMMAND_NAMES)

export function isFilesRemoteCommand(command: string): command is FilesRemoteCommand {
  return NAME_SET.has(command)
}

/** The five reads; everything else changes the host's library. */
export const FILES_REMOTE_READ_COMMANDS: readonly FilesRemoteCommand[] = [
  FILES_REMOTE_COMMANDS.list,
  FILES_REMOTE_COMMANDS.folderList,
  FILES_REMOTE_COMMANDS.search,
  FILES_REMOTE_COMMANDS.get,
  FILES_REMOTE_COMMANDS.readChunk,
]

/**
 * The commands that change the host's library. Never part of
 * `MOBILE_OUTBOUND_COMMANDS`: a move or a Trash replayed from an offline queue
 * would act on a library that has moved on since (an item restored, a folder
 * deleted), so a paired device calls these live or not at all.
 */
export const FILES_REMOTE_WRITE_COMMANDS: readonly FilesRemoteCommand[] =
  FILES_REMOTE_COMMAND_NAMES.filter((name) => !FILES_REMOTE_READ_COMMANDS.includes(name))

/**
 * The writes that are not naturally idempotent — each would make a second
 * copy, a second binding or a second upload — so they carry a body
 * `idempotencyKey` the host folds retries onto, per device.
 */
export const FILES_REMOTE_KEYED_COMMANDS: readonly FilesRemoteCommand[] = [
  FILES_REMOTE_COMMANDS.duplicate,
  FILES_REMOTE_COMMANDS.attach,
  FILES_REMOTE_COMMANDS.folderCreate,
  FILES_REMOTE_COMMANDS.uploadCommit,
]

/** The operation a host advertises when it serves the Files library remotely. */
export const FILES_REMOTE_OPERATION = FILES_REMOTE_COMMANDS.list
