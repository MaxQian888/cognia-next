/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/platform-identities", () => ({
  mergeIdentities: jest.fn(),
}))

jest.mock("@/components/ui/dialog")

// ---------------------------------------------------------------------------
// Subject + imported mocks
// ---------------------------------------------------------------------------

import { IdentityMergeDialog } from "./identity-merge-dialog"
import { mergeIdentities } from "@/lib/db/platform-identities"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"

const mockMerge = mergeIdentities as jest.Mock

function makeIdentity(id: string, displayName: string): PlatformIdentityRow {
  return {
    id,
    platform: "telegram",
    adapterId: "a1",
    remoteUserId: id,
    displayName,
    mergedFromIds: [],
    lastSeenAt: Date.now(),
  }
}

const IDENTITY_A = makeIdentity("pid_a", "Alice")
const IDENTITY_B = makeIdentity("pid_b", "Bob")

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IdentityMergeDialog", () => {
  beforeEach(() => {
    mockMerge.mockReset()
  })

  it("renders both identity cards", () => {
    render(
      <IdentityMergeDialog open onOpenChange={jest.fn()} identities={[IDENTITY_A, IDENTITY_B]} />
    )
    expect(screen.getByTestId("identity-card-pid_a")).toBeInTheDocument()
    expect(screen.getByTestId("identity-card-pid_b")).toBeInTheDocument()
  })

  it("first identity is primary by default", () => {
    render(
      <IdentityMergeDialog open onOpenChange={jest.fn()} identities={[IDENTITY_A, IDENTITY_B]} />
    )
    expect(screen.getByTestId("primary-badge-pid_a")).toBeInTheDocument()
  })

  it("clicking secondary card swaps it to primary", () => {
    render(
      <IdentityMergeDialog open onOpenChange={jest.fn()} identities={[IDENTITY_A, IDENTITY_B]} />
    )
    fireEvent.click(screen.getByTestId("identity-card-pid_b"))
    expect(screen.getByTestId("primary-badge-pid_b")).toBeInTheDocument()
  })

  it("clicking Merge calls mergeIdentities and closes dialog", async () => {
    const merged = { ...IDENTITY_A, mergedFromIds: ["pid_b"] }
    mockMerge.mockResolvedValue({ ok: true, primary: merged })

    const onOpenChange = jest.fn()
    const onMerged = jest.fn()

    render(
      <IdentityMergeDialog
        open
        onOpenChange={onOpenChange}
        identities={[IDENTITY_A, IDENTITY_B]}
        onMerged={onMerged}
      />
    )

    fireEvent.click(screen.getByTestId("merge-btn"))

    await waitFor(() => {
      expect(mockMerge).toHaveBeenCalledWith("pid_a", "pid_b")
      expect(onMerged).toHaveBeenCalledWith(merged)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("shows error when merge fails", async () => {
    mockMerge.mockResolvedValue({ ok: false, reason: "secondary_missing" })

    render(
      <IdentityMergeDialog open onOpenChange={jest.fn()} identities={[IDENTITY_A, IDENTITY_B]} />
    )

    fireEvent.click(screen.getByTestId("merge-btn"))

    await waitFor(() => {
      expect(screen.getByTestId("merge-error")).toHaveTextContent(/no longer available/i)
    })
  })

  it("locks the conversation identity as primary", () => {
    render(
      <IdentityMergeDialog
        open
        onOpenChange={jest.fn()}
        identities={[IDENTITY_A, IDENTITY_B]}
        lockedPrimaryId="pid_a"
      />
    )
    fireEvent.click(screen.getByTestId("identity-card-pid_b"))
    expect(screen.getByTestId("primary-badge-pid_a")).toBeInTheDocument()
    expect(screen.queryByTestId("primary-badge-pid_b")).not.toBeInTheDocument()
  })

  it("resets primary state when the identity tuple changes", () => {
    const identityC = makeIdentity("pid_c", "Carol")
    const { rerender } = render(
      <IdentityMergeDialog open onOpenChange={jest.fn()} identities={[IDENTITY_A, IDENTITY_B]} />
    )
    fireEvent.click(screen.getByTestId("identity-card-pid_b"))
    rerender(
      <IdentityMergeDialog open onOpenChange={jest.fn()} identities={[identityC, IDENTITY_A]} />
    )
    expect(screen.getByTestId("primary-badge-pid_c")).toBeInTheDocument()
  })
})
