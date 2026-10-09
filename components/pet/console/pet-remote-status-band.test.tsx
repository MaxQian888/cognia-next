let mockPlatform = "mobile"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { isConnectionNoticeClaimed } from "@/lib/runtime/connection-notice-claim"
import type { PetRemoteSnapshot } from "@/lib/pet/remote/types"
import type { PetConsoleRemote } from "./pet-console-actions-context"
import { PetRemoteStatusBand } from "./pet-remote-status-band"

const snapshot = (availability: PetRemoteSnapshot["availability"]): PetRemoteSnapshot => ({
  availability,
  summary: null,
  presentation: null,
  hostTime: 1,
})

function remote(over: Partial<PetConsoleRemote> = {}): PetConsoleRemote {
  return {
    snapshot: snapshot({ available: true }),
    fetchedAt: 1_000,
    error: null,
    connection: "online",
    retry: jest.fn().mockResolvedValue(undefined),
    ...over,
  }
}

beforeEach(() => {
  mockPlatform = "mobile"
})

describe("PetRemoteStatusBand", () => {
  it("says the desktop pet is being cared for, and how fresh that is", () => {
    render(<PetRemoteStatusBand remote={remote()} />)
    const band = screen.getByTestId("pet-remote-status-band")
    expect(band).toHaveAttribute("data-state", "info")
    expect(band).toHaveTextContent("Caring for your desktop pet")
    expect(band).toHaveTextContent(/Updated/)
    expect(screen.queryByTestId("pet-remote-connection-settings")).toBeNull()
  })

  it("owns the connection report while mounted", () => {
    const { unmount } = render(<PetRemoteStatusBand remote={remote()} />)
    expect(isConnectionNoticeClaimed()).toBe(true)
    unmount()
    expect(isConnectionNoticeClaimed()).toBe(false)
  })

  it.each<[string, Partial<PetConsoleRemote>, string, string]>([
    ["offline", { connection: "offline" }, "offline", "Desktop offline"],
    ["reconnecting", { connection: "connecting" }, "progress", "Reconnecting to your desktop"],
    ["unreachable", { error: "unreachable" }, "attention", "Couldn't reach your desktop"],
    ["an unreadable answer", { error: "invalid" }, "attention", "Update both apps"],
    ["loading", { snapshot: undefined, fetchedAt: null }, "progress", "Reaching your desktop"],
    [
      "a desktop still starting its pet",
      { snapshot: snapshot({ available: false, reason: "host-starting" }) },
      "progress",
      "starting the pet",
    ],
    [
      "a pet switched off on the desktop",
      { snapshot: snapshot({ available: false, reason: "disabled" }) },
      "attention",
      "switched off on your desktop",
    ],
    [
      "a headless host",
      { snapshot: snapshot({ available: false, reason: "headless-host" }) },
      "attention",
      "This host has no pet",
    ],
    [
      "any other refusal",
      { snapshot: snapshot({ available: false, reason: "secondary-window" }) },
      "attention",
      "isn't available on your desktop",
    ],
  ])("reports %s", (_label, over, tone, text) => {
    render(<PetRemoteStatusBand remote={remote(over)} />)
    const band = screen.getByTestId("pet-remote-status-band")
    expect(band).toHaveAttribute("data-state", tone)
    expect(band).toHaveTextContent(text)
  })

  it("offers the connection screen when the desktop cannot be reached", () => {
    render(<PetRemoteStatusBand remote={remote({ connection: "offline" })} />)
    expect(screen.getByTestId("pet-remote-connection-settings")).toHaveAttribute(
      "href",
      expect.stringContaining("/pair")
    )
    expect(screen.getByTestId("pet-remote-status-band")).toHaveTextContent(
      "showing the last synced state"
    )
  })

  it("says when nothing has arrived yet", () => {
    render(<PetRemoteStatusBand remote={remote({ fetchedAt: null })} />)
    expect(screen.getByTestId("pet-remote-status-band")).toHaveTextContent("Not updated yet")
  })

  it("retries once at a time", async () => {
    let finish!: () => void
    const retry = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    render(<PetRemoteStatusBand remote={remote({ retry })} />)
    const button = screen.getByTestId("pet-remote-retry")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent("Retrying")
    await act(async () => {
      finish()
    })
    expect(button).not.toBeDisabled()
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
