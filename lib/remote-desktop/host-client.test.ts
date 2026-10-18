import { HostConsentRequiredError } from "@/lib/tauri/admin-lease"
import type { Transport } from "@/lib/tauri/transport-types"

import {
  __setRemoteDesktopClientDepsForTests,
  closeRemoteDesktopSession,
  deleteRemoteDesktopTarget,
  listRemoteDesktopTargets,
  openRemoteDesktopSession,
  probeRemoteDesktop,
  REMOTE_DESKTOP_ADMIN_OPERATIONS,
  RemoteDesktopError,
  renewRemoteDesktopSession,
  saveRemoteDesktopTarget,
  setRemoteDesktopCredential,
  toRemoteDesktopError,
  type RemoteDesktopClientDeps,
} from "./host-client"
import type { RemoteDesktopHostRef } from "./types"

const local: RemoteDesktopHostRef = { kind: "local" }
const remote: RemoteDesktopHostRef = { kind: "remote", hostRef: "companion:host-1" }

const localCall = jest.fn()
const remoteCall = jest.fn()
const issueLease = jest.fn()
// A fresh transport per test: admin leases are cached per transport object.
let remoteTransport = { call: remoteCall } as unknown as Transport
const withChannel = jest.fn(
  async <T>(_ref: string, work: (lease: { transport: Transport }) => Promise<T>) =>
    work({ transport: remoteTransport })
)

beforeEach(() => {
  remoteTransport = { call: remoteCall } as unknown as Transport
  localCall.mockReset()
  remoteCall.mockReset()
  issueLease.mockReset()
  withChannel.mockClear()
  __setRemoteDesktopClientDepsForTests({
    local: { call: localCall } as unknown as Transport,
    withChannel: withChannel as unknown as NonNullable<RemoteDesktopClientDeps["withChannel"]>,
    issueLease,
    now: () => 1_000,
  })
})

afterAll(() => __setRemoteDesktopClientDepsForTests())

describe("toRemoteDesktopError", () => {
  it("reads the Host code and detail out of a rejection", () => {
    const error = toRemoteDesktopError(new Error("remote_desktop_endpoint_unconfirmed: private"))
    expect(error).toBeInstanceOf(RemoteDesktopError)
    expect(error.code).toBe("remote_desktop_endpoint_unconfirmed")
    expect(error.detail).toBe("private")
    expect(toRemoteDesktopError("remote_desktop_session_limit").detail).toBeUndefined()
    expect(toRemoteDesktopError({ message: "remote_desktop_auth_failed: bad" }).code).toBe(
      "remote_desktop_auth_failed"
    )
    // A Companion error carries the Host code in `code`.
    expect(
      toRemoteDesktopError({ code: "remote_desktop_forbidden", message: "refused" }).code
    ).toBe("remote_desktop_forbidden")
  })

  it("names an outdated Host, a pending consent and a missing lease", () => {
    expect(toRemoteDesktopError({ code: "unknown_command", message: "nope" }).code).toBe(
      "remote_desktop_host_outdated"
    )
    expect(toRemoteDesktopError(new Error("command_transport_forbidden")).code).toBe(
      "remote_desktop_host_outdated"
    )
    const consent = toRemoteDesktopError(new HostConsentRequiredError("wait", "AB12"))
    expect(consent.code).toBe("remote_desktop_host_consent_required")
    expect(consent.detail).toBe("AB12")
    expect(toRemoteDesktopError({ code: "interactive_approval_required", message: "x" }).code).toBe(
      "remote_desktop_admin_lease_required"
    )
  })

  it("maps anything else to unavailable, keeping the message as detail", () => {
    const error = toRemoteDesktopError(new Error("IPC channel closed"))
    expect(error.code).toBe("remote_desktop_unavailable")
    expect(error.detail).toBe("IPC channel closed")
    expect(toRemoteDesktopError(undefined).detail).toBeUndefined()
    const same = new RemoteDesktopError("remote_desktop_busy")
    expect(toRemoteDesktopError(same)).toBe(same)
  })
})

describe("the local Host", () => {
  it("walks every page of targets through the local door", async () => {
    localCall
      .mockResolvedValueOnce({ items: [{ id: "a" }], nextPageToken: "o:1" })
      .mockResolvedValueOnce({ items: [{ id: "b" }] })
    const targets = await listRemoteDesktopTargets(local)
    expect(targets.map((target) => target.id)).toEqual(["a", "b"])
    expect(localCall).toHaveBeenNthCalledWith(1, "remote_desktop_local_call", {
      name: "remote_desktop_target_list",
      args: { pageSize: 100 },
    })
    expect(localCall).toHaveBeenNthCalledWith(2, "remote_desktop_local_call", {
      name: "remote_desktop_target_list",
      args: { pageSize: 100, pageToken: "o:1" },
    })
    expect(withChannel).not.toHaveBeenCalled()
  })

  it("names each command with the argument shape the Rust DTOs declare, never a lease", async () => {
    localCall.mockResolvedValue({})
    const draft = { name: "NAS", bindings: [] }
    await saveRemoteDesktopTarget(local, draft)
    await deleteRemoteDesktopTarget(local, "t")
    await setRemoteDesktopCredential(local, "t", "b", "view", null)
    await probeRemoteDesktop(local, { kind: "saved", targetId: "t", bindingId: "b" })
    await openRemoteDesktopSession(local, {
      targetId: "t",
      bindingId: "b",
      mode: "control",
      takeover: true,
    })
    await renewRemoteDesktopSession(local, "s")
    await closeRemoteDesktopSession(local, "s")
    expect(localCall.mock.calls.map(([, inner]) => inner)).toEqual([
      { name: "remote_desktop_target_save", args: { draft } },
      { name: "remote_desktop_target_delete", args: { targetId: "t" } },
      {
        name: "remote_desktop_credential_set",
        args: { targetId: "t", bindingId: "b", kind: "view", value: null },
      },
      {
        name: "remote_desktop_target_probe",
        args: { request: { kind: "saved", targetId: "t", bindingId: "b" } },
      },
      {
        name: "remote_desktop_session_open",
        args: { targetId: "t", bindingId: "b", mode: "control", takeover: true },
      },
      { name: "remote_desktop_session_renew", args: { sessionId: "s" } },
      { name: "remote_desktop_session_close", args: { sessionId: "s" } },
    ])
    expect(issueLease).not.toHaveBeenCalled()
  })

  it("rejects with a typed Host refusal", async () => {
    localCall.mockRejectedValue(new Error("remote_desktop_control_busy"))
    await expect(
      openRemoteDesktopSession(local, {
        targetId: "t",
        bindingId: "b",
        mode: "control",
        takeover: false,
      })
    ).rejects.toMatchObject({ code: "remote_desktop_control_busy" })
  })
})

describe("a remote Host", () => {
  it("calls over the management channel; viewing needs no lease", async () => {
    remoteCall.mockResolvedValue({ items: [] })
    await listRemoteDesktopTargets(remote)
    remoteCall.mockResolvedValue({ sessionId: "s", transport: "companion", mode: "view" })
    await openRemoteDesktopSession(remote, {
      targetId: "t",
      bindingId: "b",
      mode: "view",
      takeover: false,
    })
    await renewRemoteDesktopSession(remote, "s")
    expect(withChannel.mock.calls.map(([ref]) => ref)).toEqual([
      "companion:host-1",
      "companion:host-1",
      "companion:host-1",
    ])
    expect(remoteCall.mock.calls[1]).toEqual([
      "remote_desktop_session_open",
      { targetId: "t", bindingId: "b", mode: "view", takeover: false },
    ])
    expect(issueLease).not.toHaveBeenCalled()
  })

  it("issues one admin lease for every admin operation and reuses it", async () => {
    issueLease.mockResolvedValue({
      token: "lease-1",
      operations: [...REMOTE_DESKTOP_ADMIN_OPERATIONS],
      expiresAt: 600_000,
    })
    remoteCall.mockResolvedValue({})
    await deleteRemoteDesktopTarget(remote, "t")
    await openRemoteDesktopSession(remote, {
      targetId: "t",
      bindingId: "b",
      mode: "control",
      takeover: false,
    })
    expect(issueLease).toHaveBeenCalledTimes(1)
    expect(issueLease).toHaveBeenCalledWith(
      [...REMOTE_DESKTOP_ADMIN_OPERATIONS],
      600,
      remoteTransport
    )
    expect(remoteCall.mock.calls).toEqual([
      ["remote_desktop_target_delete", { targetId: "t", adminLease: "lease-1" }],
      [
        "remote_desktop_session_open",
        { targetId: "t", bindingId: "b", mode: "control", takeover: false, adminLease: "lease-1" },
      ],
    ])
  })

  it("drops a refused lease so the next action asks again", async () => {
    issueLease
      .mockResolvedValueOnce({
        token: "stale",
        operations: [...REMOTE_DESKTOP_ADMIN_OPERATIONS],
        expiresAt: 600_000,
      })
      .mockResolvedValueOnce({
        token: "fresh",
        operations: [...REMOTE_DESKTOP_ADMIN_OPERATIONS],
        expiresAt: 600_000,
      })
    remoteCall.mockRejectedValueOnce({ code: "remote_desktop_admin_lease_required", message: "" })
    await expect(
      probeRemoteDesktop(remote, { kind: "saved", targetId: "t", bindingId: "b" })
    ).rejects.toMatchObject({ code: "remote_desktop_admin_lease_required" })
    remoteCall.mockResolvedValueOnce({})
    await probeRemoteDesktop(remote, { kind: "saved", targetId: "t", bindingId: "b" })
    expect(remoteCall.mock.calls[1]?.[1]).toMatchObject({ adminLease: "fresh" })
  })

  it("surfaces a Host waiting for consent with its code", async () => {
    issueLease.mockRejectedValue(new HostConsentRequiredError("wait", "XY99"))
    await expect(
      saveRemoteDesktopTarget(remote, { name: "NAS", bindings: [] })
    ).rejects.toMatchObject({ code: "remote_desktop_host_consent_required", detail: "XY99" })
    expect(remoteCall).not.toHaveBeenCalled()
  })
})
