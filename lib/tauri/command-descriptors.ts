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

/**
 * True when `name` can only ever be answered by local IPC, never by a Host
 * over a companion transport.
 *
 * `target: "client"` means the command runs *in* the client — it reaches this
 * machine's sandbox, keyring, or window, none of which a paired Host has. The
 * Host enforces exactly that: `api.rs` refuses the request with a 403
 * `command_transport_forbidden` before dispatch, and every device-facing
 * adapter (HTTP, WebSocket, WebRTC, A2A) funnels through
 * `remote_execution::authorize_transport`, which only admits `execution` and
 * `host-admin` targets. So there is no transport on which one of these can
 * succeed, and a companion shell that sends one is paying for a round trip to
 * learn something the manifest it already ships could have told it.
 *
 * `RoutingTransport` has always known this — it sends `target: "client"` to the
 * local transport rather than the active remote — but it is only installed on
 * Tauri, where a local transport exists. The Capacitor and web-companion shells
 * hold a bare `CompanionTransport`, which is why 629 commands' worth of
 * client-local calls went onto the wire and came back 403.
 */
/**
 * True when `name` reads or writes the CALLER'S OWN client data plane —
 * its sessions, messages, settings, characters, plugins and sync deltas.
 *
 * This is a different question from {@link isLocalOnlyCommand}. A `client.*`
 * capability says *whose data* the command touches; `target` says *which
 * transports may carry it*. Twenty-two of these commands are `target:
 * "execution"` precisely so a paired phone or browser can reach its own mirror
 * over the wire — `authorize_transport` admits no other target — but that does
 * not make the data the remote Host's. On the desktop, "my settings" and "my
 * sessions" are this machine's, and a `RoutingTransport` that keyed only on
 * `target` sent them to whichever Host happened to be selected.
 *
 * `client.local` is included for completeness; those commands are already
 * `target: "client"` and never reach the remote branch.
 */
export function isClientDataPlaneCommand(name: string): boolean {
  return descriptors.get(name)?.capability.startsWith("client.") === true
}

export function isLocalOnlyCommand(name: string): boolean {
  return descriptors.get(name)?.target === "client"
}
