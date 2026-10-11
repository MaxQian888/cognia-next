import { readFileSync } from "node:fs"
import { join } from "node:path"

import { MOBILE_OUTBOUND_COMMANDS } from "@/lib/db/mobile-outbound-types"
import {
  GLANCE_REMOTE_HOST_OPERATIONS,
  buildLocalHostFeatureManifest,
} from "@/lib/platform/host-feature-manifest"
import { GLANCE_ACTIVITY_RANGES } from "@/types/glance/layout"
import {
  GLANCE_REMOTE_COMMANDS,
  GLANCE_REMOTE_COMMAND_NAMES,
  GLANCE_REMOTE_FEATURE,
  GLANCE_UPDATE_EVENT,
  isGlanceRemoteCommand,
} from "./commands"
import { GLANCE_HOST_MODULES } from "./types"

interface Descriptor {
  name: string
  resource: string
  operation: string
  capability: string
  target: string
  idempotency: string
  risk: string
  approval: string
  transports: string[]
  pagination: string
  longRunning: boolean
}

type Schema = {
  type?: string
  required?: string[]
  properties?: Record<string, Schema>
  items?: Schema
  enum?: string[]
  maxItems?: number
  minLength?: number
  maxLength?: number
  oneOf?: Schema[]
  additionalProperties?: boolean
}

function readRepoFile(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8")
}

function readProtocol<T>(file: string): T {
  return JSON.parse(readRepoFile("protocol", file)) as T
}

function contractGlanceCommands(): Descriptor[] {
  const manifest = readProtocol<{ commands: Descriptor[] }>("companion-commands.json")
  return manifest.commands.filter(
    (command) => command.resource === "glance" || command.resource.startsWith("glance.")
  )
}

function requestSchemas(): Record<string, Schema> {
  return readProtocol<{ commands: Record<string, Schema> }>("companion-request-schemas.json")
    .commands
}

describe("glance remote commands", () => {
  it("matches the `glance.*` descriptors in the companion contract exactly", () => {
    expect([...GLANCE_REMOTE_COMMAND_NAMES].sort()).toEqual(
      contractGlanceCommands()
        .map((command) => command.name)
        .sort()
    )
  })

  it("makes the lease and the re-read observe reads, and the quota switch a keyed write", () => {
    const byName = new Map(contractGlanceCommands().map((command) => [command.name, command]))
    for (const name of GLANCE_REMOTE_COMMAND_NAMES) {
      const command = byName.get(name)!
      expect(command.target).toBe("execution")
      expect(command.risk).toBe("low")
      expect(command.approval).toBe("none")
      expect(command.transports).toEqual(["http", "websocket", "webrtc"])
      expect(command.pagination).toBe("none")
      expect(command.longRunning).toBe(false)
    }
    for (const name of [GLANCE_REMOTE_COMMANDS.subscribe, GLANCE_REMOTE_COMMANDS.request]) {
      const command = byName.get(name)!
      expect(command.operation).toBe("read")
      expect(command.capability).toBe("host.observe")
      expect(command.idempotency).toBe("structural")
    }
    const enable = byName.get(GLANCE_REMOTE_COMMANDS.quotaEnable)!
    expect(enable.operation).toBe("write")
    expect(enable.capability).toBe("client.write")
    expect(enable.idempotency).toBe("required")
  })

  it("publishes request schemas that hold the phone to the readers in types.ts", () => {
    const schemas = requestSchemas()
    for (const name of GLANCE_REMOTE_COMMAND_NAMES) {
      expect(schemas[name]).toBeDefined()
      expect(schemas[name]!.additionalProperties).toBe(false)
    }
    const subscribe = schemas[GLANCE_REMOTE_COMMANDS.subscribe]!
    expect(subscribe.required).toEqual(["consumer", "visible", "demand"])
    expect(subscribe.properties!.consumer!.maxLength).toBe(64)
    const demand = subscribe.properties!.demand!
    expect(demand.additionalProperties).toBe(false)
    expect(demand.properties!.modules!.items!.enum).toEqual([...GLANCE_HOST_MODULES])
    // `parseGlanceDemand` accepts up to twice the module list (duplicates fold).
    expect(demand.properties!.modules!.maxItems).toBe(GLANCE_HOST_MODULES.length * 2)
    expect(demand.properties!.activity!.properties!.range!.enum).toEqual([
      ...GLANCE_ACTIVITY_RANGES,
    ])
    expect(demand.properties!.usage!.properties!.scope!.enum).toEqual(["cognia", "all-tools"])
    expect(demand.properties!.scope!.enum).toEqual(["all", "workspace"])
    expect(demand.properties!.workspaceId!.oneOf).toEqual([
      { type: "string", minLength: 1, maxLength: 128 },
      { type: "null" },
    ])

    const request = schemas[GLANCE_REMOTE_COMMANDS.request]!
    expect(request.properties!.kind!.enum).toEqual(["refresh", "quota-refresh"])
    expect(request.properties!.key!.maxLength).toBe(300)

    const enable = schemas[GLANCE_REMOTE_COMMANDS.quotaEnable]!
    expect(enable.required).toEqual(["provider", "accountId"])
    expect(enable.properties!.provider!.maxLength).toBe(64)
    expect(enable.properties!.accountId!.maxLength).toBe(128)
  })

  it("never queues a glance command for offline replay", () => {
    // A lease renewed, a refresh or a quota switch replayed from an offline
    // queue would act on a desktop that has moved on; a phone calls these
    // live or not at all.
    const queued = new Set<string>(MOBILE_OUTBOUND_COMMANDS)
    for (const name of GLANCE_REMOTE_COMMAND_NAMES) expect(queued.has(name)).toBe(false)
  })

  it("catalogues the update channel as an opt-in, Tauri-forwarded channel", () => {
    const catalog = readRepoFile("crates", "cognia-companion-bus", "src", "event_channels.rs")
    const entry = catalog.match(
      /EventChannelSpec \{\s*pattern: "glance:\/\/update",([\s\S]*?)\n {4}\},/
    )
    expect(entry).not.toBeNull()
    expect(entry![1]).toContain("audience: ChannelAudience::Any")
    expect(entry![1]).toContain("default_on: false")
    expect(entry![1]).toContain("tauri_forwarded: true")
    expect(GLANCE_UPDATE_EVENT).toBe("glance://update")
  })

  it("advertises exactly these operations under the desktop's glance feature", () => {
    expect(GLANCE_REMOTE_FEATURE).toBe("glance.remote")
    expect([...GLANCE_REMOTE_HOST_OPERATIONS]).toEqual([...GLANCE_REMOTE_COMMAND_NAMES])
    const desktop = buildLocalHostFeatureManifest({ platform: "tauri" })
    expect(desktop.features[GLANCE_REMOTE_FEATURE]?.operations).toEqual([
      ...GLANCE_REMOTE_COMMAND_NAMES,
    ])
    expect(
      buildLocalHostFeatureManifest({ platform: "headless" }).features[GLANCE_REMOTE_FEATURE]
    ).toBeUndefined()
  })

  it("recognises only its own names", () => {
    expect(isGlanceRemoteCommand("glance_subscribe")).toBe(true)
    expect(isGlanceRemoteCommand("glance_request")).toBe(true)
    expect(isGlanceRemoteCommand("glance_quota_enable")).toBe(true)
    expect(isGlanceRemoteCommand("fleet_get_snapshot")).toBe(false)
    expect(isGlanceRemoteCommand("glance_nuke")).toBe(false)
    expect(isGlanceRemoteCommand("")).toBe(false)
  })
})
