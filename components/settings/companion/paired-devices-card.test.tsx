/**
 * Targeted smoke + interaction coverage for the extracted paired-devices
 * card. The end-to-end paths are also exercised by
 * companion-section.test.tsx; these tests pin the standalone component so
 * mobile (/me/devices) imports stay safe.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
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
    await user.click(revokeBtn)

    await waitFor(() => {
      expect(revokeIds).toEqual(["dev-c"])
    })
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
    await user.click(toggle)

    await waitFor(() => {
      expect(calls).toEqual([{ deviceId: "dev-rc", allowed: true }])
    })
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
    await user.click(toggle)

    await waitFor(() => {
      expect(calls).toEqual([{ deviceId: "dev-rc2", allowed: false }])
    })
    const rows = await listPairedDevices()
    expect(rows[0]?.allowRemoteControl).toBe(false)
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
    await user.click(resumeBtn)

    await waitFor(() => {
      expect(unrevokeIds).toEqual(["dev-d"])
    })
    const rows = await listPairedDevices()
    expect(rows[0]?.pausedAt).toBeUndefined()
  })
})
