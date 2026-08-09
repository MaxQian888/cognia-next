import manifestJson from "@/protocol/companion-commands.json"

export type CommandTarget = "client" | "execution" | "host-admin" | "service"
export type CommandOperation = "read" | "write" | "side-effect"
export type CommandRisk = "low" | "high" | "critical"
export type CommandApproval = "none" | "interactive" | "signed-policy"
export type CommandIdempotency = "structural" | "required" | "forbidden"
export type CommandTransport = "http" | "websocket" | "webrtc" | "internal"

export interface CommandDescriptor {
  name: string
  target: CommandTarget
  operation: CommandOperation
  capability: string
  risk: CommandRisk
  approval: CommandApproval
  idempotency: CommandIdempotency
  transports: CommandTransport[]
  inputSchema: string
  outputSchema: string
}

export interface CommandManifest {
  schemaVersion: number
  commands: CommandDescriptor[]
}

const manifest = manifestJson as CommandManifest
const descriptors = new Map<string, CommandDescriptor>()

for (const descriptor of manifest.commands) {
  if (descriptors.has(descriptor.name)) {
    throw new Error(`Duplicate companion command descriptor: ${descriptor.name}`)
  }
  descriptors.set(descriptor.name, Object.freeze({ ...descriptor }))
}

export function getCommandDescriptor(name: string): CommandDescriptor | undefined {
  return descriptors.get(name)
}

export function getCommandManifest(): Readonly<CommandManifest> {
  return manifest
}
