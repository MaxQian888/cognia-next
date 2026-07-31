/**
 * Targeted smoke + interaction coverage for the extracted paired-devices
 * card. The end-to-end paths are also exercised by
 * companion-section.test.tsx; these tests pin the standalone component so
 * mobile (/me/devices) imports stay safe.
 */

import "fake-indexeddb/auto"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PairedDevicesCard } from "./paired-devices-card"
import { transport } from "@/lib/tauri"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { addPairedDevice, listPairedDevices } from "@/lib/db/paired-devices"

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

let callSpy: jest.SpiedFunction<typeof transport.call>

async function interactUntil(
  action: () => Promise<void>,
  assertion: () => void | Promise<void>
): Promise<void> {
  await act(async () => {
    await action()
    let lastError: unknown
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await assertion()
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        return
      } catch (error) {
        lastError = error
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
    }
    throw lastError
  })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
  callSpy.mockImplementation(async () => undefined as unknown as never)
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("<PairedDevicesCard />", () => {
  it("shows the empty state when no devices are paired", async () => {
    render(<PairedDevicesCard />)
    expect(await screen.findByText(/No devices paired yet/i)).toBeInTheDocument()
  })

  it("renders a row per paired device", async () => {
    await addPairedDevice({
      deviceId: "dev-a",
      label: "Max's iPhone",
      platform: "ios",
      pubkey: "k1",
      appVersion: "0.1.0",
      nowMs: Date.now() - 60_000,
    })
    await addPairedDevice({
      deviceId: "dev-b",
      label: "Pixel 8",
      platform: "android",
      pubkey: "k2",
      appVersion: "0.1.0",
      nowMs: Date.now() - 5 * 60_000,
    })

    render(<PairedDevicesCard />)
    expect(await screen.findByText("Max's iPhone")).toBeInTheDocument()
    expect(screen.getByText("Pixel 8")).toBeInTheDocument()
  })

  it("revoking a device calls both Dexie and the Rust deny-list", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-c",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })

    const revokeIds: string[] = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_revoke_device") {
        revokeIds.push((args as { deviceId: string }).deviceId)
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const revokeBtn = await screen.findByRole("button", {
      name: /Revoke Phone/i,
    })
    await interactUntil(
      () => user.click(revokeBtn),
      () => expect(revokeIds).toEqual(["dev-c"])
    )
    const rows = await listPairedDevices()
    expect(rows[0]?.revokedAt).toBeDefined()
  })

  it("enabling remote control calls Dexie + the Rust allow list and persists the bit", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-rc",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })

    const calls: Array<{ deviceId: string; allowed: boolean }> = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_set_remote_control") {
        calls.push(args as { deviceId: string; allowed: boolean })
      }
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const toggle = await screen.findByRole("switch", {
      name: /Toggle remote control for Phone/i,
    })
    await interactUntil(
      () => user.click(toggle),
      () => expect(calls).toEqual([{ deviceId: "dev-rc", allowed: true }])
    )
    const rows = await listPairedDevices()
    expect(rows[0]?.allowRemoteControl).toBe(true)
  })

  it("disabling remote control records an explicit false without a biometric prompt", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-rc2",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    {
      const { setRemoteControlAllowed } = await import("@/lib/db/paired-devices")
      await setRemoteControlAllowed("dev-rc2", true)
    }

    const calls: Array<{ deviceId: string; allowed: boolean }> = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_set_remote_control") {
        calls.push(args as { deviceId: string; allowed: boolean })
      }
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const toggle = await screen.findByRole("switch", {
      name: /Toggle remote control for Phone/i,
    })
    await interactUntil(
      () => user.click(toggle),
      () => expect(calls).toEqual([{ deviceId: "dev-rc2", allowed: false }])
    )
    const rows = await listPairedDevices()
    expect(rows[0]?.allowRemoteControl).toBe(false)
  })

  it("enables Locked Use only for a device that already has remote control", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-locked",
      label: "Trusted Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    {
      const { setRemoteControlAllowed } = await import("@/lib/db/paired-devices")
      await setRemoteControlAllowed("dev-locked", true)
    }

    const calls: Array<{ deviceId: string; allowed: boolean }> = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_set_locked_computer_use") {
        calls.push(args as { deviceId: string; allowed: boolean })
      }
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const lockedToggle = await screen.findByRole("switch", {
      name: /Toggle Locked Use for Trusted Phone/i,
    })
    await interactUntil(
      () => user.click(lockedToggle),
      () => expect(calls).toEqual([{ deviceId: "dev-locked", allowed: true }])
    )
    const rows = await listPairedDevices()
    expect(rows[0]?.allowLockedComputerUse).toBe(true)
  })

  it("revokes Locked Use when remote control is disabled", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-both",
      label: "Trusted Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    {
      const { setLockedComputerUseAllowed, setRemoteControlAllowed } =
        await import("@/lib/db/paired-devices")
      await setRemoteControlAllowed("dev-both", true)
      await setLockedComputerUseAllowed("dev-both", true)
    }

    const commands: string[] = []
    callSpy.mockImplementation(async (name: string) => {
      commands.push(name)
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const remoteControlToggle = await screen.findByRole("switch", {
      name: /Toggle remote control for Trusted Phone/i,
    })
    await interactUntil(
      () => user.click(remoteControlToggle),
      () =>
        expect(commands).toEqual([
          "companion_set_locked_computer_use",
          "companion_set_remote_control",
        ])
    )
    const rows = await listPairedDevices()
    expect(rows[0]?.allowRemoteControl).toBe(false)
    expect(rows[0]?.allowLockedComputerUse).toBe(false)
  })

  it("resuming a paused device clears the deny-list entry", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-d",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    // Pause first so the resume button is rendered.
    {
      const { pausePairedDevice } = await import("@/lib/db/paired-devices")
      await pausePairedDevice("dev-d")
    }

    const unrevokeIds: string[] = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "companion_unrevoke_device") {
        unrevokeIds.push((args as { deviceId: string }).deviceId)
        return undefined as unknown as never
      }
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const resumeBtn = await screen.findByRole("button", { name: /Resume Phone/i })
    await interactUntil(
      () => user.click(resumeBtn),
      () => expect(unrevokeIds).toEqual(["dev-d"])
    )
    const rows = await listPairedDevices()
    expect(rows[0]?.pausedAt).toBeUndefined()
  })

  it("grants agent control through its own switch and Rust command", async () => {
    // R4 was blocked because a paired device could only ever hold a device
    // JWT and these arms were service-token-only. This switch is the grant
    // that unblocks it — and it is separate from remote control on purpose.
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-ac1",
      label: "Laptop",
      platform: "web",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })

    const calls: Array<{ name: string; args: unknown }> = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      calls.push({ name, args })
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const toggle = await screen.findByRole("switch", {
      name: /Toggle agent control for Laptop/i,
    })
    await interactUntil(
      () => user.click(toggle),
      () =>
        expect(calls).toContainEqual({
          name: "companion_set_agent_control",
          args: { deviceId: "dev-ac1", allowed: true },
        })
    )
    // Enabling it must not have touched the remote-control grant.
    expect(calls.some((c) => c.name === "companion_set_remote_control")).toBe(false)
    const { getPairedDevice } = await import("@/lib/db/paired-devices")
    const row = await getPairedDevice("dev-ac1")
    expect(row?.allowAgentControl).toBe(true)
    expect(row?.allowRemoteControl).toBeUndefined()
  })

  it("provisions and grants remote terminal access independently", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-terminal",
      label: "Tablet",
      platform: "android",
      pubkey: "tablet-public-key",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    const descriptor = {
      hostId: "host-a",
      issuedAt: 1,
      expiresAt: 2,
      lanUrl: "wss://192.168.1.8:27890/ws/terminal",
      signingPublicKey: "signing-key",
      credentialKeyId: "credential-key",
      signature: "signature",
    }
    const calls: Array<{ name: string; args: unknown }> = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      calls.push({ name, args })
      if (name === "terminal_host_service") {
        return { running: true, endpoint: "local", descriptor } as never
      }
      return undefined as never
    })

    render(<PairedDevicesCard />)
    const terminalToggle = await screen.findByRole("switch", {
      name: /Toggle terminal access for Tablet/i,
    })
    await interactUntil(
      () => user.click(terminalToggle),
      () =>
        expect(calls).toContainEqual({
          name: "companion_set_remote_terminal",
          args: { deviceId: "dev-terminal", allowed: true },
        })
    )
    expect(calls).toContainEqual({
      name: "terminal_host_service",
      args: {
        action: {
          kind: "provision",
          deviceId: "dev-terminal",
          devicePublicKey: "tablet-public-key",
        },
      },
    })
    expect(calls.some((call) => call.name === "companion_set_remote_control")).toBe(false)
    expect(calls.some((call) => call.name === "companion_set_agent_control")).toBe(false)
    const { getPairedDevice } = await import("@/lib/db/paired-devices")
    const row = await getPairedDevice("dev-terminal")
    expect(row?.allowRemoteTerminal).toBe(true)
    expect(row?.terminalHostDescriptor).toEqual(descriptor)
  })

  it("rolls back the persisted terminal grant when the native allow-list rejects it", async () => {
    await addPairedDevice({
      deviceId: "dev-terminal-fail",
      label: "Phone",
      platform: "ios",
      pubkey: "phone-public-key",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    let rejectTerminalGrant!: (error: Error) => void
    const terminalGrant = new Promise<void>((_resolve, reject) => {
      rejectTerminalGrant = reject
    })
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      if (name === "terminal_host_service") {
        return {
          descriptor: {
            hostId: "host-a",
            issuedAt: 1,
            expiresAt: 2,
            signingPublicKey: "signing-key",
            credentialKeyId: "credential-key",
            signature: "signature",
          },
        } as never
      }
      if (name === "companion_set_remote_terminal" && (args as { allowed: boolean }).allowed) {
        await terminalGrant
      }
      return undefined as never
    })

    render(<PairedDevicesCard />)
    const terminalToggle = await screen.findByRole("switch", {
      name: /Toggle terminal access for Phone/i,
    })
    await interactUntil(
      async () => {
        fireEvent.click(terminalToggle)
      },
      async () => {
        const { getPairedDevice } = await import("@/lib/db/paired-devices")
        expect((await getPairedDevice("dev-terminal-fail"))?.allowRemoteTerminal).toBe(true)
      }
    )
    expect(terminalToggle).toBeChecked()
    await interactUntil(
      async () => rejectTerminalGrant(new Error("native grant failed")),
      async () => {
        const { getPairedDevice } = await import("@/lib/db/paired-devices")
        expect((await getPairedDevice("dev-terminal-fail"))?.allowRemoteTerminal).toBe(false)
      }
    )
    const { getPairedDevice } = await import("@/lib/db/paired-devices")
    expect((await getPairedDevice("dev-terminal-fail"))?.allowRemoteTerminal).toBe(false)
  })
})
