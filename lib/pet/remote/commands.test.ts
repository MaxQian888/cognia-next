import { readFileSync } from "node:fs"
import { join } from "node:path"

import { MOBILE_OUTBOUND_COMMANDS } from "@/lib/db/mobile-outbound-types"
import { PET_REMOTE_COMMAND_NAMES, PET_REMOTE_WRITE_COMMANDS, isPetRemoteCommand } from "./commands"

interface Descriptor {
  name: string
  resource: string
  operation: string
  capability: string
  target: string
  idempotency: string
}

function contractPetCommands(): Descriptor[] {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "protocol", "companion-commands.json"), "utf8")
  ) as { commands: Descriptor[] }
  // The `pet` resource tree. The overlay window's own `pet_window_*` commands
  // live under `desktop.pet` and are client-local, not remote care.
  return manifest.commands.filter(
    (command) => command.resource === "pet" || command.resource.startsWith("pet.")
  )
}

describe("pet remote commands", () => {
  it("matches the `pet` resource descriptors in the companion contract exactly", () => {
    expect([...PET_REMOTE_COMMAND_NAMES].sort()).toEqual(
      contractPetCommands()
        .map((command) => command.name)
        .sort()
    )
  })

  it("lists every non-read descriptor as a write, and nothing else", () => {
    const writes = contractPetCommands()
      .filter((command) => command.operation !== "read")
      .map((command) => command.name)
      .sort()
    expect([...PET_REMOTE_WRITE_COMMANDS].sort()).toEqual(writes)
  })

  it("targets the execution host with the client capabilities", () => {
    for (const command of contractPetCommands()) {
      expect(command.target).toBe("execution")
      expect(command.capability).toBe(command.operation === "read" ? "client.read" : "client.write")
    }
  })

  it("never queues a pet command for offline replay", () => {
    const queued = new Set<string>(MOBILE_OUTBOUND_COMMANDS)
    for (const name of PET_REMOTE_COMMAND_NAMES) expect(queued.has(name)).toBe(false)
  })

  it("recognises only its own names", () => {
    expect(isPetRemoteCommand("pet_act")).toBe(true)
    expect(isPetRemoteCommand("perf_hotspots")).toBe(false)
    expect(isPetRemoteCommand("pet_toggle")).toBe(false)
  })
})
