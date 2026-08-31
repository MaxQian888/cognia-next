/** @jest-environment jsdom */

/**
 * The gate has to distinguish three refusals that used to look identical
 * behind `isTauri()`: the host never offered the command, the device is one
 * grant away, and the connection dropped.
 */

const snapshotMock = jest.fn()

jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => snapshotMock(),
}))

import { renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"

import { useWorkspaceCommandGate } from "./use-workspace-command-gate"
import messages from "@/i18n/messages/en.json"

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  )
}

function companion(overrides: { operations?: string[]; grants?: string[]; online?: boolean } = {}) {
  return {
    target: { id: "mobile-companion", kind: "companion", platform: "mobile", hostKind: "desktop" },
    vaultState: "unlocked",
    connectionState: overrides.online === false ? "offline" : "online",
    host: {
      compatible: true,
      operations: overrides.operations ?? [
        "task_workspace_managed_delete",
        "git_worktree_prune",
        "host_admin_lease_issue",
      ],
      grants: overrides.grants ?? ["workspace.write", "git.write", "host.admin"],
    },
  }
}

function gateFor(snapshot: unknown) {
  snapshotMock.mockReturnValue(snapshot)
  return renderHook(() => useWorkspaceCommandGate(), { wrapper }).result.current
}

beforeEach(() => jest.clearAllMocks())

describe("useWorkspaceCommandGate", () => {
  it("allows a published command the device holds every grant for", () => {
    expect(gateFor(companion())("task_workspace_managed_delete")).toEqual({
      available: true,
      reason: null,
    })
  })

  it("answers per command, not per host", () => {
    // The exact state `isTauri()` could not express: one command reachable and
    // its neighbour not, on the same host.
    const gate = gateFor(
      companion({ operations: ["git_worktree_prune", "host_admin_lease_issue"] })
    )

    expect(gate("git_worktree_prune").available).toBe(true)
    expect(gate("task_workspace_managed_delete").available).toBe(false)
  })

  it("separates the capabilities two neighbouring worktree actions need", () => {
    // `git_worktree_prune` is `git.write` and `task_workspace_managed_delete`
    // is `workspace.write`. A device can hold one and not the other, so the
    // two buttons in the same row can legitimately disagree.
    const gate = gateFor(companion({ grants: ["workspace.write", "host.admin"] }))

    expect(gate("git_worktree_prune").available).toBe(false)
    expect(gate("git_worktree_prune").reason).toContain("git.write")
    expect(gate("task_workspace_managed_delete").available).toBe(true)
  })

  it("names the missing grant rather than just refusing", () => {
    const verdict = gateFor(companion({ grants: ["workspace.write"] }))(
      "task_workspace_managed_delete"
    )

    expect(verdict.available).toBe(false)
    expect(verdict.reason).toContain("host.admin")
  })

  it("separates offline from unsupported", () => {
    const offline = gateFor(companion({ online: false }))("task_workspace_managed_delete")
    const unsupported = gateFor(companion({ operations: ["host_admin_lease_issue"] }))(
      "task_workspace_managed_delete"
    )

    expect(offline.reason).not.toEqual(unsupported.reason)
    expect(offline.reason).toMatch(/offline/i)
  })

  it("treats a native execution host as available", () => {
    expect(
      gateFor({ target: null, vaultState: "unlocked", connectionState: "online" })(
        "task_workspace_managed_delete"
      )
    ).toEqual({ available: true, reason: null })
  })
})
