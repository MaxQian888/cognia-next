import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  LIBRARY_FOLDER_COLORS,
  LIBRARY_FOLDER_ICONS,
  LIBRARY_ITEM_KINDS,
} from "@/lib/db/files-library-types"
import { MOBILE_OUTBOUND_COMMANDS } from "@/lib/db/mobile-outbound-types"
import {
  FILES_REMOTE_COMMAND_NAMES,
  FILES_REMOTE_KEYED_COMMANDS,
  FILES_REMOTE_OPERATION,
  FILES_REMOTE_READ_COMMANDS,
  FILES_REMOTE_WRITE_COMMANDS,
  isFilesRemoteCommand,
} from "./commands"

interface Descriptor {
  name: string
  resource: string
  operation: string
  capability: string
  target: string
  idempotency: string
  pagination: string
}

type Schema = {
  required?: string[]
  properties?: Record<string, Schema & { enum?: string[]; oneOf?: Schema[] }>
  enum?: string[]
  oneOf?: Schema[]
}

function readProtocol<T>(file: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), "protocol", file), "utf8")) as T
}

function contractFilesCommands(): Descriptor[] {
  const manifest = readProtocol<{ commands: Descriptor[] }>("companion-commands.json")
  return manifest.commands.filter(
    (command) =>
      command.resource === "files.library" || command.resource.startsWith("files.library.")
  )
}

describe("files remote commands", () => {
  it("matches the `files.library` descriptors in the companion contract exactly", () => {
    expect([...FILES_REMOTE_COMMAND_NAMES].sort()).toEqual(
      contractFilesCommands()
        .map((command) => command.name)
        .sort()
    )
  })

  it("splits reads from writes the way the contract does", () => {
    const contract = contractFilesCommands()
    expect([...FILES_REMOTE_READ_COMMANDS].sort()).toEqual(
      contract
        .filter((c) => c.operation === "read")
        .map((c) => c.name)
        .sort()
    )
    expect([...FILES_REMOTE_WRITE_COMMANDS].sort()).toEqual(
      contract
        .filter((c) => c.operation !== "read")
        .map((c) => c.name)
        .sort()
    )
  })

  it("targets the execution host with the client capabilities, and keys every write", () => {
    for (const command of contractFilesCommands()) {
      expect(command.target).toBe("execution")
      const read = command.operation === "read"
      expect(command.capability).toBe(read ? "client.read" : "client.write")
      expect(command.idempotency).toBe(read ? "structural" : "required")
    }
  })

  it("pages both lists by token", () => {
    const paged = contractFilesCommands()
      .filter((command) => command.pagination === "page-token")
      .map((command) => command.name)
      .sort()
    expect(paged).toEqual(["files_library_folder_list", "files_library_list"])
  })

  it("asks a body idempotencyKey of exactly the keyed writes", () => {
    const schemas = readProtocol<{ commands: Record<string, Schema> }>(
      "companion-request-schemas.json"
    ).commands
    for (const name of FILES_REMOTE_COMMAND_NAMES) {
      const schema = schemas[name]
      expect(schema).toBeDefined()
      const keyed = FILES_REMOTE_KEYED_COMMANDS.includes(name)
      expect(Boolean(schema!.properties?.idempotencyKey)).toBe(keyed)
      expect((schema!.required ?? []).includes("idempotencyKey")).toBe(keyed)
    }
  })

  it("publishes the folder colors, icons and item kinds the host accepts", () => {
    const requests = readProtocol<{ commands: Record<string, Schema> }>(
      "companion-request-schemas.json"
    ).commands
    const style = requests.files_library_folder_style!.properties!
    expect(style.color!.oneOf![0]!.enum).toEqual([...LIBRARY_FOLDER_COLORS])
    expect(style.icon!.oneOf![0]!.enum).toEqual([...LIBRARY_FOLDER_ICONS])
    const responses = readProtocol<{ $defs: Record<string, Schema> }>(
      "companion-response-schemas.json"
    ).$defs
    expect(responses.FilesRemoteEntry!.properties!.kind!.enum).toEqual([...LIBRARY_ITEM_KINDS])
    expect(responses.FilesRemoteFolder!.properties!.color!.enum).toEqual([...LIBRARY_FOLDER_COLORS])
  })

  it("never queues a Files command for offline replay", () => {
    const queued = new Set<string>(MOBILE_OUTBOUND_COMMANDS)
    for (const name of FILES_REMOTE_COMMAND_NAMES) expect(queued.has(name)).toBe(false)
  })

  it("recognises only its own names, and names the list as the surface's operation", () => {
    expect(isFilesRemoteCommand("files_library_trash")).toBe(true)
    expect(isFilesRemoteCommand("file_share_create")).toBe(false)
    expect(isFilesRemoteCommand("files_library_nuke")).toBe(false)
    expect(FILES_REMOTE_OPERATION).toBe("files_library_list")
  })
})
