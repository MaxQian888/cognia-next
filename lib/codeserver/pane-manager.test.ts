/**
 * @jest-environment jsdom
 *
 * jsdom (not the default `node` project for `lib/**`) because the manager
 * publishes a `data-pro-ide-active` marker on `document.documentElement`.
 */
let mockIsTauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    embedCreate: jest.fn(),
    embedSetBounds: jest.fn(),
    embedSetVisible: jest.fn(),
    embedNavigate: jest.fn(),
    embedSetBackground: jest.fn(),
    embedDestroy: jest.fn(),
  },
}))

import type { ElementRect } from "@/lib/browser/protocol"
import { codeServerClient } from "@/lib/codeserver/client"
import {
  __resetCodeServerPaneManagerForTesting,
  claimCodeServerPane,
  destroyCodeServerPane,
  getCodeServerPaneOwner,
  isProIdePanePinnedWithin,
  PRO_IDE_REGION_ATTR,
  releaseCodeServerPane,
  setCodeServerPaneBackground,
  setCodeServerPaneVisible,
  updateCodeServerPaneRect,
} from "./pane-manager"

const client = codeServerClient as jest.Mocked<typeof codeServerClient>

const RECT: ElementRect = { x: 10, y: 20, width: 300, height: 400 }
const PARKED: ElementRect = { x: -32000, y: -32000, width: 0, height: 0 }
const URL_A = "http://127.0.0.1:43117/"
const URL_B = "http://127.0.0.1:43118/"

/** Let the manager's serialized promise chain drain. */
const drain = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  mockIsTauri = true
  __resetCodeServerPaneManagerForTesting()
  client.embedCreate.mockReset().mockResolvedValue("codeserver-embed")
  client.embedSetBounds.mockReset().mockResolvedValue(undefined)
  client.embedSetVisible.mockReset().mockResolvedValue(undefined)
  client.embedNavigate.mockReset().mockResolvedValue(undefined)
  client.embedSetBackground.mockReset().mockResolvedValue(undefined)
  client.embedDestroy.mockReset().mockResolvedValue(undefined)
})

it("creates the webview on the first claim and records the owner", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())

  expect(client.embedCreate).toHaveBeenCalledWith(URL_A, RECT, undefined)
  expect(client.embedNavigate).not.toHaveBeenCalled()
  expect(getCodeServerPaneOwner()).toBe("editor")
})

it("re-shows the existing webview instead of recreating it on a repeat claim", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())

  expect(client.embedCreate).toHaveBeenCalledTimes(1)
  expect(client.embedNavigate).not.toHaveBeenCalled()
  expect(client.embedSetBounds).toHaveBeenCalledWith(RECT)
})

it("navigates rather than recreating when the claimed url changes", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  await claimCodeServerPane("editor", URL_B, RECT, jest.fn())

  expect(client.embedCreate).toHaveBeenCalledTimes(1)
  expect(client.embedNavigate).toHaveBeenCalledWith(URL_B)
})

it("revokes the previous owner when another surface claims the pane", async () => {
  const onRevoked = jest.fn()
  await claimCodeServerPane("editor", URL_A, RECT, onRevoked)

  await claimCodeServerPane("dock", URL_A, RECT, jest.fn())

  expect(onRevoked).toHaveBeenCalledTimes(1)
  expect(getCodeServerPaneOwner()).toBe("dock")
})

it("does not revoke when the same owner re-claims", async () => {
  const onRevoked = jest.fn()
  await claimCodeServerPane("editor", URL_A, RECT, onRevoked)
  await claimCodeServerPane("editor", URL_B, RECT, onRevoked)

  expect(onRevoked).not.toHaveBeenCalled()
})

it("is inert outside Tauri", async () => {
  mockIsTauri = false
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  updateCodeServerPaneRect("editor", RECT)
  setCodeServerPaneVisible("editor", false)
  releaseCodeServerPane("editor")
  await destroyCodeServerPane()

  expect(client.embedCreate).not.toHaveBeenCalled()
  expect(client.embedSetBounds).not.toHaveBeenCalled()
  expect(client.embedDestroy).not.toHaveBeenCalled()
})

it("propagates creation failures and leaves the pane recreatable", async () => {
  client.embedCreate.mockRejectedValueOnce(new Error("main window not found"))

  await expect(claimCodeServerPane("editor", URL_A, RECT, jest.fn())).rejects.toThrow(
    "main window not found"
  )

  client.embedCreate.mockResolvedValueOnce("codeserver-embed")
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  expect(client.embedCreate).toHaveBeenCalledTimes(2)
})

it("propagates navigation failures", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  client.embedNavigate.mockRejectedValueOnce(new Error("navigation failed"))

  await expect(claimCodeServerPane("editor", URL_B, RECT, jest.fn())).rejects.toThrow(
    "navigation failed"
  )
})

it("skips a queued claim whose owner was replaced while it waited", async () => {
  let releaseCreate: (v: string) => void = () => {}
  client.embedCreate.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      releaseCreate = resolve
    })
  )
  const first = claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  // Queue a second claim from another owner behind the in-flight create.
  const second = claimCodeServerPane("dock", URL_B, RECT, jest.fn())
  // Now a third claim takes ownership back before `second` gets its turn.
  const third = claimCodeServerPane("editor", URL_A, RECT, jest.fn())

  releaseCreate("codeserver-embed")
  await Promise.all([first, second, third])

  // `second` bailed out — it never navigated to URL_B.
  expect(client.embedNavigate).not.toHaveBeenCalledWith(URL_B)
  expect(getCodeServerPaneOwner()).toBe("editor")
})

it("pushes bounds only for the owner, and only while visible", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  client.embedSetBounds.mockClear()

  const next: ElementRect = { x: 1, y: 2, width: 30, height: 40 }
  updateCodeServerPaneRect("dock", next)
  expect(client.embedSetBounds).not.toHaveBeenCalled()

  updateCodeServerPaneRect("editor", next)
  await drain()
  expect(client.embedSetBounds).toHaveBeenCalledWith(next)

  client.embedSetBounds.mockClear()
  setCodeServerPaneVisible("editor", false)
  await drain()
  updateCodeServerPaneRect("editor", RECT)
  await drain()
  expect(client.embedSetBounds).not.toHaveBeenCalled()
})

it("does not push bounds before the webview exists", async () => {
  updateCodeServerPaneRect("editor", RECT)
  await drain()
  expect(client.embedSetBounds).not.toHaveBeenCalled()
})

it("parks off-screen when hidden and restores the last rect when shown", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  client.embedSetVisible.mockClear()

  setCodeServerPaneVisible("editor", false)
  await drain()
  expect(client.embedSetVisible).toHaveBeenCalledWith(false, PARKED)

  setCodeServerPaneVisible("editor", true)
  await drain()
  expect(client.embedSetVisible).toHaveBeenCalledWith(true, RECT)
})

it("ignores visibility changes from non-owners and before creation", async () => {
  setCodeServerPaneVisible("editor", false)
  await drain()
  expect(client.embedSetVisible).not.toHaveBeenCalled()

  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  client.embedSetVisible.mockClear()
  setCodeServerPaneVisible("dock", false)
  await drain()
  expect(client.embedSetVisible).not.toHaveBeenCalled()
})

it("release parks the webview but never destroys it", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  client.embedSetVisible.mockClear()

  releaseCodeServerPane("editor")
  await drain()

  expect(client.embedSetVisible).toHaveBeenCalledWith(false, PARKED)
  expect(client.embedDestroy).not.toHaveBeenCalled()
  expect(getCodeServerPaneOwner()).toBeNull()
})

it("a claim after release re-shows the same webview without recreating it", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  releaseCodeServerPane("editor")
  await drain()

  await claimCodeServerPane("dock", URL_A, RECT, jest.fn())

  expect(client.embedCreate).toHaveBeenCalledTimes(1)
  expect(client.embedSetBounds).toHaveBeenCalledWith(RECT)
})

it("ignores a release from a surface that does not hold the pane", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  client.embedSetVisible.mockClear()

  releaseCodeServerPane("dock")
  await drain()

  expect(client.embedSetVisible).not.toHaveBeenCalled()
  expect(getCodeServerPaneOwner()).toBe("editor")
})

it("release is a no-op when nothing was ever created", async () => {
  releaseCodeServerPane("editor")
  await drain()
  expect(client.embedSetVisible).not.toHaveBeenCalled()
})

it("destroy tears the webview down and clears ownership", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())

  await destroyCodeServerPane()

  expect(client.embedDestroy).toHaveBeenCalledTimes(1)
  expect(getCodeServerPaneOwner()).toBeNull()

  // The next claim must create a fresh webview.
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  expect(client.embedCreate).toHaveBeenCalledTimes(2)
})

it("destroy tells the current owner it lost the pane", async () => {
  // An explicit stop of the underlying code-server destroys the pane from
  // outside the hosting surface. Unless that surface is told, it stays in Pro
  // IDE mode and re-claims on its next rect update — resurrecting a webview
  // pointed at a port nothing serves any more.
  const onRevoked = jest.fn()
  await claimCodeServerPane("editor", URL_A, RECT, onRevoked)

  await destroyCodeServerPane()

  expect(onRevoked).toHaveBeenCalledTimes(1)
  expect(getCodeServerPaneOwner()).toBeNull()

  // ...and the revoked owner's later rect pushes are ignored, so nothing gets
  // re-created behind its back.
  updateCodeServerPaneRect("editor", RECT)
  await drain()
  expect(client.embedCreate).toHaveBeenCalledTimes(1)
})

it("destroy is a no-op when no webview exists", async () => {
  await destroyCodeServerPane()
  expect(client.embedDestroy).not.toHaveBeenCalled()
})

it("destroy with no owner does not blow up", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  releaseCodeServerPane("editor")
  await drain()

  await expect(destroyCodeServerPane()).resolves.toBeUndefined()
  expect(client.embedDestroy).toHaveBeenCalledTimes(1)
})

it("swallows a destroy failure so teardown never rejects", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  client.embedDestroy.mockRejectedValueOnce(new Error("already gone"))

  await expect(destroyCodeServerPane()).resolves.toBeUndefined()
})

describe("shell-transition marker", () => {
  const marker = () => document.documentElement.getAttribute("data-pro-ide-active")

  it("is set to the holding surface's id and cleared on release", async () => {
    expect(marker()).toBeNull()

    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
    // Valued rather than empty: `[data-pro-ide-active]` still matches for the
    // CSS guards, and a reader can tell *which* surface holds the pane.
    expect(marker()).toBe("editor")

    releaseCodeServerPane("editor")
    expect(marker()).toBeNull()
  })

  it("stays set across a handoff between surfaces", async () => {
    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
    await claimCodeServerPane("dock", URL_A, RECT, jest.fn())

    // The webview never left the screen, so the guard must not blink off — it
    // just re-points at the new holder.
    expect(marker()).toBe("dock")
  })

  it("is cleared by destroy", async () => {
    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
    await destroyCodeServerPane()
    expect(marker()).toBeNull()
  })

  it("is not cleared by a release from a non-owner", async () => {
    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
    releaseCodeServerPane("dock")
    expect(marker()).toBe("editor")
  })
})

describe("isProIdePanePinnedWithin", () => {
  /** A container holding a reserved region, as a hosting surface renders it. */
  const withRegion = () => {
    const container = document.createElement("div")
    const region = document.createElement("div")
    region.setAttribute(PRO_IDE_REGION_ATTR, "")
    container.append(region)
    return container
  }

  it("is false when no surface holds the pane, even with a region present", () => {
    // The reserved <div> is rendered by CodeServerPane whether or not the
    // native webview has been claimed over it, so containment alone is not
    // enough — an unclaimed pane is not pinned over anything.
    expect(isProIdePanePinnedWithin(withRegion())).toBe(false)
  })

  it("is true once a surface holds the pane and the region is inside", async () => {
    await claimCodeServerPane("dock", URL_A, RECT, jest.fn())
    expect(isProIdePanePinnedWithin(withRegion())).toBe(true)
  })

  it("is false for a container that does not contain the region", async () => {
    await claimCodeServerPane("dock", URL_A, RECT, jest.fn())
    // The Agent Team editor may hold the pane while an unrelated container
    // animates; that container must keep its animation.
    expect(isProIdePanePinnedWithin(document.createElement("div"))).toBe(false)
  })

  it("is false for a null container", async () => {
    await claimCodeServerPane("dock", URL_A, RECT, jest.fn())
    expect(isProIdePanePinnedWithin(null)).toBe(false)
  })

  it("goes false again once the holder releases", async () => {
    const container = withRegion()
    await claimCodeServerPane("dock", URL_A, RECT, jest.fn())
    expect(isProIdePanePinnedWithin(container)).toBe(true)

    releaseCodeServerPane("dock")
    expect(isProIdePanePinnedWithin(container)).toBe(false)
  })
})

it("keeps draining the queue after a failed round-trip", async () => {
  await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
  client.embedSetBounds.mockRejectedValueOnce(new Error("bounds failed"))

  updateCodeServerPaneRect("editor", { x: 0, y: 0, width: 1, height: 1 })
  await drain()
  updateCodeServerPaneRect("editor", RECT)
  await drain()

  expect(client.embedSetBounds).toHaveBeenLastCalledWith(RECT)
})

describe("pane background", () => {
  it("creates the webview already painted in the app background", async () => {
    // Set before any claim — the appearance sync can run while no surface is
    // mounted, and the very first create must not flash the platform default.
    setCodeServerPaneBackground("#0b1220")
    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())

    expect(client.embedCreate).toHaveBeenCalledWith(URL_A, RECT, "#0b1220")
    // Nothing to push: the create already carried the colour.
    expect(client.embedSetBackground).not.toHaveBeenCalled()
  })

  it("pushes a later theme flip to the live webview", async () => {
    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
    setCodeServerPaneBackground("#ffffff")
    await drain()

    expect(client.embedSetBackground).toHaveBeenCalledWith("#ffffff")
  })

  it("ignores a repeat of the same colour", async () => {
    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
    setCodeServerPaneBackground("#ffffff")
    await drain()
    client.embedSetBackground.mockClear()

    setCodeServerPaneBackground("#ffffff")
    await drain()

    expect(client.embedSetBackground).not.toHaveBeenCalled()
  })

  it("remembers a colour set while no webview exists, for the next create", async () => {
    setCodeServerPaneBackground("#101010")
    expect(client.embedSetBackground).not.toHaveBeenCalled()

    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
    expect(client.embedCreate).toHaveBeenCalledWith(URL_A, RECT, "#101010")
  })

  it("does not touch the native layer outside the desktop shell", async () => {
    mockIsTauri = false
    setCodeServerPaneBackground("#123456")
    await drain()

    expect(client.embedSetBackground).not.toHaveBeenCalled()
  })

  it("swallows a failed background push", async () => {
    await claimCodeServerPane("editor", URL_A, RECT, jest.fn())
    client.embedSetBackground.mockRejectedValue(new Error("pane closed"))

    setCodeServerPaneBackground("#222222")
    await drain()

    expect(client.embedSetBackground).toHaveBeenCalled()
  })
})
