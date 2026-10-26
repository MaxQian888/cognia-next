import { HostConsentRequiredError } from "./admin-lease"
import { createInteractiveApprovalScope, withInteractiveApproval } from "./interactive-approval"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

describe("withInteractiveApproval", () => {
  it("leaves a call this host runs itself unchanged and mints nothing", async () => {
    const issue = jest.fn()
    await expect(
      withInteractiveApproval("bot_installation_mutate", { a: 1 }, { isRemote: () => false, issue })
    ).resolves.toEqual({ a: 1 })
    expect(issue).not.toHaveBeenCalled()
  })

  it("attaches a lease minted for exactly this command on a paired host", async () => {
    const issue = jest.fn(async () => ({ token: "lease-1" }))
    await expect(
      withInteractiveApproval(
        "companion_push_configure_fcm",
        { x: "y" },
        { isRemote: () => true, issue }
      )
    ).resolves.toEqual({ x: "y", adminLease: "lease-1" })
    expect(issue).toHaveBeenCalledWith(["companion_push_configure_fcm"])
  })

  it("passes on a host waiting for a person, code and all", async () => {
    const issue = jest.fn(async () => {
      throw new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED (code K7Q2)", "K7Q2")
    })
    await expect(
      withInteractiveApproval("bot_trigger_set_armed", {}, { isRemote: () => true, issue })
    ).rejects.toMatchObject({ consentCode: "K7Q2" })
  })
})

describe("explicit approval scope", () => {
  afterEach(() => clearActiveRuntimeTargetContext())

  it.each([
    ["account_two", "host-one"],
    ["account_one", "host-two"],
  ])(
    "invalidates the default guard when the route changes to %s/%s",
    async (accountId, targetId) => {
      setActiveRuntimeTargetContext("account_one", "host-one")
      const call = jest.fn()
      const issue = jest.fn().mockResolvedValue({
        token: "route-lease",
        operations: ["browser_navigate"],
        expiresAt: Date.now() + 600_000,
      })
      const scope = createInteractiveApprovalScope(["browser_navigate"], {
        target: { call },
        remote: true,
        issue,
      })
      await scope.authorize()
      setActiveRuntimeTargetContext(accountId, targetId)
      await expect(scope.call("browser_navigate", {})).rejects.toMatchObject({
        code: "approval_target_changed",
      })
      // Returning to the same identifiers must not revive an earlier routing generation.
      setActiveRuntimeTargetContext("account_one", "host-one")
      await expect(scope.call("browser_navigate", {})).rejects.toMatchObject({
        code: "approval_target_changed",
      })
      expect(call).not.toHaveBeenCalled()
      expect(issue).toHaveBeenCalledTimes(1)
    }
  )
  function setup(remote = true) {
    const call = jest.fn().mockResolvedValue({ ok: true })
    const issue = jest.fn().mockResolvedValue({ token: "browser-lease", expiresAt: 601_000 })
    let current = true
    let now = 1_000
    const scope = createInteractiveApprovalScope(["browser_session_ensure", "browser_navigate"], {
      target: { call },
      remote,
      isCurrent: () => current,
      now: () => now,
      issue,
    })
    return {
      scope,
      call,
      issue,
      switchHost: () => {
        current = false
      },
      expire: () => {
        now = 601_000
      },
    }
  }

  it("never requests authority from a call or background read", async () => {
    const { scope, call, issue } = setup()
    await scope.call("browser_runtime_status", {})
    await expect(scope.call("browser_session_ensure", {})).rejects.toMatchObject({
      code: "interactive_approval_required",
    })
    expect(issue).not.toHaveBeenCalled()
    expect(call.mock.calls).toEqual([["browser_runtime_status", {}]])
  })

  it("reuses explicit authority only for its declared operations for ten minutes", async () => {
    const { scope, call, issue, expire } = setup()
    await scope.authorize()
    expect(issue).toHaveBeenCalledWith(
      ["browser_session_ensure", "browser_navigate"],
      600,
      expect.objectContaining({ call })
    )
    await scope.call("browser_session_ensure", { workspaceId: "w" })
    await scope.call("browser_navigate", { url: "https://example.com" })
    await scope.call("browser_snapshot", {})
    expect(call.mock.calls).toEqual([
      ["browser_session_ensure", { workspaceId: "w", adminLease: "browser-lease" }],
      ["browser_navigate", { url: "https://example.com", adminLease: "browser-lease" }],
      ["browser_snapshot", {}],
    ])
    expire()
    await expect(scope.call("browser_navigate", {})).rejects.toMatchObject({
      code: "interactive_approval_required",
    })
    expect(issue).toHaveBeenCalledTimes(1)
  })

  it("does not carry a pending or issued lease across an identity switch", async () => {
    const { scope, call, issue, switchHost } = setup()
    let resolve!: (value: { token: string; expiresAt: number }) => void
    issue.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const pending = scope.authorize()
    switchHost()
    resolve({ token: "old-host", expiresAt: 999_999 })
    await expect(pending).rejects.toMatchObject({ code: "approval_target_changed" })
    await expect(scope.call("browser_navigate", {})).rejects.toMatchObject({
      code: "approval_target_changed",
    })
    expect(call).not.toHaveBeenCalled()
  })

  it("clears refused authority without automatically requesting another lease", async () => {
    const { scope, call, issue } = setup()
    await scope.authorize()
    call.mockRejectedValueOnce(
      Object.assign(new Error("expired"), { code: "interactive_approval_required" })
    )
    await expect(scope.call("browser_navigate", {})).rejects.toThrow("expired")
    await expect(scope.call("browser_navigate", {})).rejects.toMatchObject({
      code: "interactive_approval_required",
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(issue).toHaveBeenCalledTimes(1)
  })

  it("propagates pending host consent and clears explicit cancellation", async () => {
    const { scope, issue, call } = setup()
    issue.mockRejectedValueOnce(
      new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED (code K7Q2)", "K7Q2")
    )
    await expect(scope.authorize()).rejects.toMatchObject({ consentCode: "K7Q2" })
    await scope.authorize()
    scope.clear()
    await expect(scope.call("browser_navigate", {})).rejects.toMatchObject({
      code: "interactive_approval_required",
    })
    expect(call).not.toHaveBeenCalled()
  })

  it("keeps local host calls unchanged", async () => {
    const { scope, call, issue } = setup(false)
    await scope.authorize()
    await scope.call("browser_navigate", { url: "https://example.com" })
    expect(issue).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith("browser_navigate", { url: "https://example.com" })
  })
})
