/**
 * Targeted smoke + interaction coverage for the extracted paired-devices
 * card. The end-to-end paths are also exercised by
 * companion-section.test.tsx; these tests pin the standalone component so
 * mobile (/me/devices) imports stay safe.
 */

import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PairedDevicesCard } from "./paired-devices-card"
import { transport } from "@/lib/tauri"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { addPairedDevice, listPairedDevices } from "@/lib/db/paired-devices"

// Declared before the factory runs, and referenced lazily inside it, so the
// hoisted `jest.mock` call does not trip the TDZ.
const guardOutcome: { blocked: "cancelled" | "unavailable" | null } = { blocked: null }
jest.mock("@/hooks/use-biometric-guard", () => {
  const actual = jest.requireActual("@/hooks/use-biometric-guard")
  return {
    ...actual,
    useBiometricGuard: () => {
      const real = actual.useBiometricGuard()
      return async (gate: unknown, action: () => Promise<unknown>) =>
        guardOutcome.blocked
          ? { kind: "blocked", reason: guardOutcome.blocked }
          : real(gate, action)
    },
  }
})

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
  guardOutcome.blocked = null
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

  /**
   * The UI axis of the Locked Use dormancy contract (CLAUDE.md Working Rule 7).
   *
   * Locked Use has no enforcement point yet — its policy core is complete but
   * the macOS native edge has not shipped — so the switch must be inert and
   * must say so. An enabled switch here would tell the owner they had granted
   * a permission that nothing consumes.
   *
   * When the native edge lands, this test and the Rust dormancy pin in
   * `src-tauri/src/companion_api/locked_use_allow_list.rs` come down together.
   */
  it("renders Locked Use as inert and labelled, because nothing enforces it yet", async () => {
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

    const calls: string[] = []
    callSpy.mockImplementation(async (name: string) => {
      calls.push(name)
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const lockedToggle = await screen.findByRole("switch", {
      name: /Toggle Locked Use for Trusted Phone/i,
    })
    // Inert even for a device that holds remote control — the precondition the
    // grant used to require — so the reason it is off is the missing native
    // edge, not the device's configuration.
    expect(lockedToggle).toBeDisabled()
    expect(lockedToggle).not.toBeChecked()
    expect(screen.getByText(/Not available in this build/i)).toBeInTheDocument()

    await user.click(lockedToggle)
    expect(calls).not.toContain("companion_set_locked_computer_use")
    const rows = await listPairedDevices()
    expect(rows[0]?.allowLockedComputerUse).toBeUndefined()
  })

  /**
   * The switch must render the host's answer, not the Dexie mirror. The two
   * diverge whenever a grant moves anywhere else — device enrolment defaults,
   * the `cognia-server devices` CLI, the owner API — and a switch showing the
   * mirror would misreport what the request-path gates will actually allow.
   */
  it("renders each grant from the host's SecurityStore, not the Dexie mirror", async () => {
    await addPairedDevice({
      deviceId: "dev-store",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    // Mirror says nothing is granted…
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_list_device_grants") {
        // …the host says terminal access is.
        return [
          { deviceId: "dev-store", control: false, agentControl: false, terminal: true },
        ] as never
      }
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const terminalToggle = await screen.findByRole("switch", {
      name: /Toggle terminal access for Phone/i,
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(terminalToggle).toBeChecked()
    expect(
      screen.getByRole("switch", { name: /Toggle remote control for Phone/i })
    ).not.toBeChecked()
    expect(
      screen.getByRole("switch", { name: /Toggle agent control for Phone/i })
    ).not.toBeChecked()
    const rows = await listPairedDevices()
    expect(rows[0]?.allowRemoteTerminal).toBe(false)
  })

  it("falls back to the Dexie mirror when the host cannot report its grants", async () => {
    // A host that errors must not be read as "nothing is granted" — that would
    // render every switch off and invite the owner to re-grant permissions the
    // device already holds.
    await addPairedDevice({
      deviceId: "dev-offline",
      label: "Phone",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    {
      const { setRemoteControlAllowed } = await import("@/lib/db/paired-devices")
      await setRemoteControlAllowed("dev-offline", true)
    }
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    callSpy.mockImplementation(async (name: string) => {
      if (name === "companion_list_device_grants") throw new Error("host unreachable")
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const remoteControlToggle = await screen.findByRole("switch", {
      name: /Toggle remote control for Phone/i,
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(remoteControlToggle).toBeChecked()
    // The failure is surfaced rather than swallowed.
    expect(warn).toHaveBeenCalledWith("companion_list_device_grants failed", expect.any(Error))
  })

  it("re-reads the host after terminal access is revoked", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-term-refresh",
      label: "Tablet",
      platform: "android",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    // The host starts out reporting the grant; the revoke must make the card
    // ask again rather than trust its own optimistic guess.
    let terminal = true
    const calls: string[] = []
    callSpy.mockImplementation(async (name: string) => {
      calls.push(name)
      if (name === "companion_list_device_grants") {
        return [
          { deviceId: "dev-term-refresh", control: false, agentControl: false, terminal },
        ] as never
      }
      if (name === "companion_set_remote_terminal") terminal = false
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const terminalToggle = await screen.findByRole("switch", {
      name: /Toggle terminal access for Tablet/i,
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(terminalToggle).toBeChecked()

    // Not `interactUntil` — that polls inside a single `act`, so React never
    // flushes the re-render the assertion is waiting for. DOM assertions need
    // the act scope to close first.
    await act(async () => {
      await user.click(terminalToggle)
    })
    await waitFor(() => expect(terminalToggle).not.toBeChecked())
    // Once on mount, once after the revoke.
    expect(calls.filter((name) => name === "companion_list_device_grants")).toHaveLength(2)
  })

  /**
   * The enabling direction of every elevated grant is biometric-gated. When the
   * gate refuses, nothing may reach the host — a switch that grants anyway
   * would make the prompt decorative.
   */
  describe.each([
    ["remote control", /Toggle remote control for Phone/i, "companion_set_remote_control"],
    ["agent control", /Toggle agent control for Phone/i, "companion_set_agent_control"],
    ["terminal access", /Toggle terminal access for Phone/i, "companion_set_remote_terminal"],
  ])("a blocked biometric gate on %s", (_label, toggleName, command) => {
    it.each([["cancelled" as const], ["unavailable" as const]])(
      "grants nothing when the gate reports %s",
      async (reason) => {
        const user = userEvent.setup()
        await addPairedDevice({
          deviceId: "dev-blocked",
          label: "Phone",
          platform: "ios",
          pubkey: "k",
          appVersion: "0.1.0",
          nowMs: Date.now(),
        })
        guardOutcome.blocked = reason
        const calls: string[] = []
        callSpy.mockImplementation(async (name: string) => {
          calls.push(name)
          if (name === "terminal_host_service") {
            return { descriptor: { hostId: "h", issuedAt: 1, expiresAt: 2 } } as never
          }
          return undefined as unknown as never
        })

        render(<PairedDevicesCard />)
        const toggle = await screen.findByRole("switch", { name: toggleName })
        await act(async () => {
          await user.click(toggle)
        })
        await waitFor(() => expect(calls).not.toContain(command))
        const rows = await listPairedDevices()
        expect(rows[0]?.allowRemoteControl).toBeUndefined()
        expect(rows[0]?.allowAgentControl).toBeUndefined()
        expect(rows[0]?.allowRemoteTerminal).toBe(false)
      }
    )
  })

  // Pause, revoke and resume ride the same gate. A refusal must leave the
  // deny-list untouched in every direction.
  describe.each([["cancelled" as const], ["unavailable" as const]])(
    "a %s biometric gate",
    (reason) => {
      it.each([
        ["pause", /Pause Phone/i],
        ["revoke", /Revoke Phone/i],
      ])("does not %s the device", async (_action, buttonName) => {
        const user = userEvent.setup()
        await addPairedDevice({
          deviceId: "dev-gate-blocked",
          label: "Phone",
          platform: "ios",
          pubkey: "k",
          appVersion: "0.1.0",
          nowMs: Date.now(),
        })
        guardOutcome.blocked = reason
        const calls: string[] = []
        callSpy.mockImplementation(async (name: string) => {
          calls.push(name)
          return undefined as unknown as never
        })

        render(<PairedDevicesCard />)
        const button = await screen.findByRole("button", { name: buttonName })
        await act(async () => {
          await user.click(button)
        })
        await waitFor(() => expect(calls).not.toContain("companion_revoke_device"))
        const rows = await listPairedDevices()
        expect(rows[0]?.pausedAt).toBeUndefined()
        expect(rows[0]?.revokedAt).toBeUndefined()
      })

      it("does not resume a paused device", async () => {
        const user = userEvent.setup()
        await addPairedDevice({
          deviceId: "dev-resume-blocked",
          label: "Phone",
          platform: "ios",
          pubkey: "k",
          appVersion: "0.1.0",
          nowMs: Date.now(),
        })
        {
          const { pausePairedDevice } = await import("@/lib/db/paired-devices")
          await pausePairedDevice("dev-resume-blocked")
        }
        guardOutcome.blocked = reason
        const calls: string[] = []
        callSpy.mockImplementation(async (name: string) => {
          calls.push(name)
          return undefined as unknown as never
        })

        render(<PairedDevicesCard />)
        const resumeBtn = await screen.findByRole("button", { name: /Resume Phone/i })
        await act(async () => {
          await user.click(resumeBtn)
        })
        await waitFor(() => expect(calls).not.toContain("companion_unrevoke_device"))
        const rows = await listPairedDevices()
        expect(rows[0]?.pausedAt).toBeDefined()
      })
    }
  )

  it("disabling agent control needs no biometric prompt and re-reads the host", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-ac-off",
      label: "Laptop",
      platform: "web",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    {
      const { setAgentControlAllowed } = await import("@/lib/db/paired-devices")
      await setAgentControlAllowed("dev-ac-off", true)
    }
    // Refusing the gate must not block the *reducing* direction: a user pulling
    // a permission back should never be stopped by a failing sensor.
    guardOutcome.blocked = "unavailable"
    const calls: Array<{ name: string; args: unknown }> = []
    callSpy.mockImplementation(async (name: string, args?: unknown) => {
      calls.push({ name, args })
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const toggle = await screen.findByRole("switch", {
      name: /Toggle agent control for Laptop/i,
    })
    await act(async () => {
      await user.click(toggle)
    })
    await waitFor(() =>
      expect(calls).toContainEqual({
        name: "companion_set_agent_control",
        args: { deviceId: "dev-ac-off", allowed: false },
      })
    )
    expect(calls.filter((c) => c.name === "companion_list_device_grants")).toHaveLength(2)
    const rows = await listPairedDevices()
    expect(rows[0]?.allowAgentControl).toBe(false)
  })

  it("shows a pinned certificate fingerprint, and says so when there is none", async () => {
    await addPairedDevice({
      deviceId: "dev-pinned",
      label: "Pinned",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      serverFingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33",
      nowMs: Date.now(),
    })
    await addPairedDevice({
      deviceId: "dev-unpinned",
      label: "Unpinned",
      platform: "ios",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })

    render(<PairedDevicesCard />)
    expect(await screen.findByLabelText(/Pinned cert AA:BB:CC/i)).toBeInTheDocument()
    // Truncated for the cell, with the full value kept in the accessible name.
    expect(screen.getByText("AA:BB:CC:DD:…")).toBeInTheDocument()
    expect(screen.getAllByText(/^unpinned$/i).length).toBeGreaterThan(0)
  })

  it("surfaces a terminal host that provisions no descriptor instead of granting", async () => {
    const user = userEvent.setup()
    await addPairedDevice({
      deviceId: "dev-no-descriptor",
      label: "Tablet",
      platform: "android",
      pubkey: "k",
      appVersion: "0.1.0",
      nowMs: Date.now(),
    })
    const calls: string[] = []
    callSpy.mockImplementation(async (name: string) => {
      calls.push(name)
      // The host answers, but without a descriptor — granting anyway would
      // leave the phone holding a capability it has no way to use.
      if (name === "terminal_host_service") return {} as never
      return undefined as unknown as never
    })

    render(<PairedDevicesCard />)
    const terminalToggle = await screen.findByRole("switch", {
      name: /Toggle terminal access for Tablet/i,
    })
    await act(async () => {
      await user.click(terminalToggle)
    })
    await waitFor(() => expect(calls).toContain("terminal_host_service"))
    expect(calls).not.toContain("companion_set_remote_terminal")
    const rows = await listPairedDevices()
    expect(rows[0]?.allowRemoteTerminal).toBe(false)
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
      // The grant read is not part of the ordering under test.
      if (name !== "companion_list_device_grants") commands.push(name)
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
