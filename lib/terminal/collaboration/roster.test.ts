import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { TerminalParticipant } from "../types"
import {
  COMPANION_CLIENT_PREFIX,
  DESKTOP_CLIENT_ID,
  deviceIdOfClient,
  mergeDevicesWithRoster,
  participantLabel,
  projectRoster,
} from "./roster"

const desktop: TerminalParticipant = {
  clientId: DESKTOP_CLIENT_ID,
  deviceId: null,
  local: true,
  role: "controller",
}
const phone: TerminalParticipant = {
  clientId: `${COMPANION_CLIENT_PREFIX}dev-1`,
  deviceId: "dev-1",
  local: false,
  role: "viewer",
}

function device(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    deviceId: "dev-1",
    label: "Max's iPhone",
    platform: "ios",
    pubkey: "pk",
    pairedAt: 1,
    allowRemoteControl: false,
    allowAgentControl: false,
    allowRemoteTerminal: false,
    allowLockedComputerUse: false,
    ...overrides,
  } as PairedDeviceRow
}

describe("deviceIdOfClient", () => {
  it("parses companion client ids and rejects everything else", () => {
    expect(deviceIdOfClient("companion:dev-1")).toBe("dev-1")
    expect(deviceIdOfClient("companion:")).toBeNull()
    expect(deviceIdOfClient("desktop")).toBeNull()
  })
})

describe("projectRoster", () => {
  it("marks the roster unknown for hosts that predate participants and keeps the count", () => {
    const roster = projectRoster({ id: "s", currentController: "desktop", attachedClients: 3 })
    expect(roster).toEqual({
      sessionId: "s",
      known: false,
      participants: [],
      controllerId: "desktop",
      remote: [],
      shared: false,
      attachedCount: 3,
    })
    expect(projectRoster({ id: "s", projectId: null } as never).attachedCount).toBe(0)
  })

  it("derives controller, remote set and shared flag from the roster", () => {
    const roster = projectRoster({
      id: "s",
      participants: [desktop, phone],
      currentController: "stale-value",
      attachedClients: 99,
    })
    expect(roster.known).toBe(true)
    expect(roster.controllerId).toBe(DESKTOP_CLIENT_ID)
    expect(roster.remote).toEqual([phone])
    expect(roster.shared).toBe(true)
    expect(roster.attachedCount).toBe(2)
  })

  it("falls back to currentController when nobody in the roster holds the lease", () => {
    const viewerOnly = { ...desktop, role: "viewer" as const }
    expect(
      projectRoster({ id: "s", participants: [viewerOnly], currentController: null }).controllerId
    ).toBeNull()
    expect(
      projectRoster({ id: "s", participants: [viewerOnly], currentController: "x" }).controllerId
    ).toBe("x")
    expect(projectRoster({ id: "s", participants: [viewerOnly] }).shared).toBe(false)
  })
})

describe("mergeDevicesWithRoster", () => {
  it("prefers the host grant snapshot, falls back to the Dexie mirror, and flags attachment", () => {
    const rows = mergeDevicesWithRoster(
      [
        device(),
        device({ deviceId: "dev-2", label: "Tablet", allowRemoteTerminal: true }),
        device({ deviceId: "dev-3", label: "Old", revokedAt: 5 }),
        device({ deviceId: "dev-4", label: "Paused", pausedAt: 5, allowRemoteTerminal: true }),
      ],
      new Map([["dev-1", { terminal: true }]]),
      { participants: [desktop, phone] }
    )
    expect(rows.map((r) => [r.deviceId, r.terminalGranted, r.blocked, r.attached, r.role])).toEqual(
      [
        ["dev-1", true, false, true, "viewer"],
        ["dev-2", true, false, false, null],
        ["dev-3", false, true, false, null],
        ["dev-4", true, true, false, null],
      ]
    )
    expect(rows[0]).toMatchObject({ label: "Max's iPhone", platform: "ios" })
  })

  it("matches attachment by client id when the participant carries no deviceId", () => {
    const rows = mergeDevicesWithRoster([device()], undefined, {
      participants: [{ ...phone, deviceId: null, role: "controller" }],
    })
    expect(rows[0].attached).toBe(true)
    expect(rows[0].role).toBe("controller")
    expect(rows[0].terminalGranted).toBe(false)
  })
})

describe("participantLabel", () => {
  const devices = [device()]
  it("labels the desktop, known devices, unknown devices, and foreign clients", () => {
    expect(participantLabel(desktop, devices, "This device")).toBe("This device")
    expect(participantLabel({ ...desktop, local: false }, devices, "Me")).toBe("Me")
    expect(participantLabel(phone, devices, "Me")).toBe("Max's iPhone")
    expect(
      participantLabel({ ...phone, deviceId: "dev-9", clientId: "companion:dev-9" }, devices, "Me")
    ).toBe("dev-9")
    expect(
      participantLabel({ clientId: "cli-tool", deviceId: null, local: false }, devices, "Me")
    ).toBe("cli-tool")
  })
})
