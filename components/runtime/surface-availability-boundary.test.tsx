import { useEffect } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"

import {
  claimConnectionNotice,
  isConnectionNoticeClaimed,
} from "@/lib/runtime/connection-notice-claim"
import { SurfaceAvailabilityBoundary, exitFor } from "./surface-availability-boundary"

let pathname = "/browser"
let snapshot: Record<string, unknown>

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}))

let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => compact,
}))

jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => snapshot,
}))

const lockAccountMock = jest.fn(async () => {})
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => ({ lock: lockAccountMock }) },
}))

jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => "web",
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

beforeEach(() => {
  compact = false
  pathname = "/browser"
  snapshot = {
    target: { id: "web-standalone", kind: "standalone", platform: "web" },
    vaultState: "unlocked",
    connectionState: "online",
  }
})

it("returns an explanatory recovery page for a host-only standalone deep link", () => {
  render(
    <SurfaceAvailabilityBoundary>
      <div>browser implementation</div>
    </SurfaceAvailabilityBoundary>
  )

  expect(screen.queryByText("browser implementation")).not.toBeInTheDocument()
  expect(screen.getByText("states.unsupported")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "pairHost" })).toHaveAttribute("href", "/pair")
})

it("names the page it is standing in for", () => {
  // The state line is generic; the page name is what the reader clicked.
  pathname = "/source-control"
  render(
    <SurfaceAvailabilityBoundary>
      <div>scm implementation</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByTestId("surface-unavailable-name")).toHaveTextContent("sourceControl")
})

it("lets the recovery page claim the whole content slot", () => {
  // The shell hands routes a flex-row slot. A `<main>` that neither grows nor
  // spans it shrinks to its own max-width and hugs the left edge, which is how
  // /performance ended up showing a narrow column against an empty page.
  render(
    <SurfaceAvailabilityBoundary>
      <div>browser implementation</div>
    </SurfaceAvailabilityBoundary>
  )

  const main = screen.getByRole("main")
  expect(main).toHaveClass("flex-1", "w-full")
})

it("sends a blocked /me sub-page back to /me, not into chat", () => {
  // The boundary replaces the whole route, page chrome included, so /me/terminal
  // lost its back arrow. The only exit left was a button that dropped the reader
  // into chat, one level past where they came from.
  pathname = "/me/terminal"
  render(
    <SurfaceAvailabilityBoundary>
      <div>terminal implementation</div>
    </SurfaceAvailabilityBoundary>
  )

  expect(screen.queryByText("terminal implementation")).not.toBeInTheDocument()
  expect(screen.getByRole("link", { name: "back" })).toHaveAttribute("href", "/me")
  expect(screen.queryByRole("link", { name: "backToChat" })).not.toBeInTheDocument()
})

it("still offers chat as the exit from a top-level capability route", () => {
  render(
    <SurfaceAvailabilityBoundary>
      <div>browser implementation</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByRole("link", { name: "backToChat" })).toHaveAttribute("href", "/")
})

it("on the phone shell, sends a hub-opened screen back to its hub, not into chat", () => {
  // Source Control is opened from Me; "Back to chat" dropped the reader into
  // a tab they never came from while the bar lit Me.
  compact = true
  pathname = "/source-control"
  render(
    <SurfaceAvailabilityBoundary>
      <div>scm implementation</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByRole("link", { name: "back" })).toHaveAttribute("href", "/me")
  expect(screen.queryByRole("link", { name: "backToChat" })).not.toBeInTheDocument()
})

describe("exitFor", () => {
  it("keeps chat as the desktop exit for top-level routes", () => {
    expect(exitFor("/source-control", false)).toEqual({ href: "/", label: "backToChat" })
  })
  it("keeps chat for routes the Chat tab owns on the phone", () => {
    expect(exitFor("/browser", true)).toEqual({ href: "/", label: "backToChat" })
  })
  it("sends a Discover-owned screen back to Discover on the phone", () => {
    expect(exitFor("/twin", true)).toEqual({ href: "/discover", label: "back" })
  })
  it("sends /me sub-pages to /me everywhere", () => {
    expect(exitFor("/me/terminal", false)).toEqual({ href: "/me", label: "back" })
  })
  // A blocked hub is its own tab's href; an exit to itself goes nowhere.
  it("never links a blocked hub back to itself", () => {
    for (const hub of ["/me", "/discover", "/workflows"]) {
      expect(exitFor(hub, true)).toEqual({ href: "/", label: "backToChat" })
    }
  })
})

it("keeps the standalone plugin library fully available without a read-only banner", () => {
  pathname = "/plugins"

  render(
    <SurfaceAvailabilityBoundary>
      <div>plugin library</div>
    </SurfaceAvailabilityBoundary>
  )

  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.getByText("plugin library")).toBeInTheDocument()
})

it("keeps cached Companion content visible with an explicit read-only banner", () => {
  pathname = "/workflows/runs"
  snapshot = {
    target: {
      id: "companion-studio",
      kind: "companion",
      hostKind: "desktop",
      platform: "web",
    },
    vaultState: "unlocked",
    connectionState: "offline",
  }
  render(
    <SurfaceAvailabilityBoundary>
      <div>cached runs</div>
    </SurfaceAvailabilityBoundary>
  )

  // One line: the state, what it means here, the way back.
  expect(screen.getByRole("status")).toHaveTextContent("band.hostOffline · band.cacheOnly")
  expect(screen.getByTestId("surface-read-only-recovery")).toHaveAttribute(
    "href",
    "/pair?mode=recover&state=offline"
  )
  expect(screen.getByText("cached runs")).toBeInTheDocument()
})

it("leaves the read-only report to a route notice that claims the connection", () => {
  pathname = "/workflows/runs"
  snapshot = {
    target: {
      id: "companion-studio",
      kind: "companion",
      hostKind: "desktop",
      platform: "web",
    },
    vaultState: "unlocked",
    connectionState: "offline",
  }
  const release = claimConnectionNotice()
  try {
    render(
      <SurfaceAvailabilityBoundary>
        <div>cached runs</div>
      </SurfaceAvailabilityBoundary>
    )
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.getByText("cached runs")).toBeInTheDocument()
  } finally {
    release()
  }
})

// The claimant lives INSIDE this boundary (the chat's strip). If the claim
// changed the tree shape, the route would remount, the claimant would release,
// and the shape would flip back — "Maximum update depth exceeded".
it("does not remount the route when the connection claim toggles", () => {
  pathname = "/workflows/runs"
  snapshot = {
    target: {
      id: "companion-studio",
      kind: "companion",
      hostKind: "desktop",
      platform: "web",
    },
    vaultState: "unlocked",
    connectionState: "offline",
  }
  let mounts = 0
  function Route() {
    useEffect(() => {
      mounts += 1
    }, [])
    return <div>cached runs</div>
  }
  render(
    <SurfaceAvailabilityBoundary>
      <Route />
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByRole("status")).toBeInTheDocument()
  let release!: () => void
  act(() => {
    release = claimConnectionNotice()
  })
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  act(() => release())
  expect(screen.getByRole("status")).toBeInTheDocument()
  expect(mounts).toBe(1)
})

it("does not intercept internal popup routes", () => {
  pathname = "/pet-popup"
  render(
    <SurfaceAvailabilityBoundary>
      <div>popup harness</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByText("popup harness")).toBeInTheDocument()
})

it.each(["left", "right"])(
  "keeps the %s offline sidebar beside the conversation below the notice",
  (side) => {
    pathname = "/"
    snapshot = {
      target: { id: "companion-studio", kind: "companion", hostKind: "desktop", platform: "web" },
      vaultState: "unlocked",
      connectionState: "offline",
    }
    render(
      <SurfaceAvailabilityBoundary>
        {side === "left" && <aside>Conversation sidebar</aside>}
        <main>Cached conversation</main>
        {side === "right" && <aside>Conversation sidebar</aside>}
      </SurfaceAvailabilityBoundary>
    )

    const sidebar = screen.getByRole("complementary")
    const contentRow = sidebar.parentElement!
    expect(screen.getByRole("main").parentElement).toBe(contentRow)
    expect(contentRow).toHaveClass("flex", "min-h-0", "min-w-0", "flex-1")
    expect(contentRow).not.toHaveClass("flex-col")
    expect(contentRow).not.toContainElement(screen.getByRole("status"))
  }
)

it.each([
  { vaultState: "unavailable", state: "requires-pairing", recovery: "pairHost", href: "/pair" },
  {
    vaultState: "unlocked",
    host: { compatible: false },
    state: "incompatible",
    recovery: "diagnose",
    href: "/me/diagnostics",
  },
])(
  "preserves $state recovery instead of rendering cached content",
  ({ state, recovery, href, ...runtime }) => {
    pathname = "/"
    snapshot = {
      target: { id: "companion-studio", kind: "companion", hostKind: "desktop", platform: "web" },
      connectionState: "offline",
      ...runtime,
    }
    render(
      <SurfaceAvailabilityBoundary>
        <div>Cached conversation</div>
      </SurfaceAvailabilityBoundary>
    )
    expect(screen.queryByText("Cached conversation")).not.toBeInTheDocument()
    expect(screen.getByText(`states.${state}`)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: recovery })).toHaveAttribute("href", href)
  }
)

/**
 * The browser Vault is the local account's key, opened only by the account
 * lock screen. The recovery used to link `/me/profile`, which has no unlock
 * control and was itself blocked by `requires-unlock`. It now relocks the
 * account, and `AccountGate` swaps the app for the unlock screen.
 */
describe("a locked Vault", () => {
  beforeEach(() => {
    pathname = "/"
    snapshot = {
      target: { id: "companion-studio", kind: "companion", hostKind: "desktop", platform: "web" },
      vaultState: "locked",
      connectionState: "offline",
    }
    lockAccountMock.mockClear()
  })

  it("offers the account unlock instead of a page that cannot unlock anything", () => {
    render(
      <SurfaceAvailabilityBoundary>
        <div>Cached conversation</div>
      </SurfaceAvailabilityBoundary>
    )
    expect(screen.queryByText("Cached conversation")).not.toBeInTheDocument()
    expect(screen.getByText("states.requires-unlock")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "unlockVault" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "unlockVault" }))
    expect(lockAccountMock).toHaveBeenCalledTimes(1)
  })

  it("never sends the reader to /me/profile for it", () => {
    render(
      <SurfaceAvailabilityBoundary>
        <div>Cached conversation</div>
      </SurfaceAvailabilityBoundary>
    )
    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("href", "/me/profile")
    }
  })
})

it("keeps non-cacheable offline routes behind their recovery page", () => {
  pathname = "/remote-sessions"
  snapshot = {
    target: { id: "companion-studio", kind: "companion", hostKind: "desktop", platform: "web" },
    vaultState: "unlocked",
    connectionState: "offline",
  }
  render(
    <SurfaceAvailabilityBoundary>
      <div>Remote sessions</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.queryByText("Remote sessions")).not.toBeInTheDocument()
  expect(screen.getByText("states.offline")).toBeInTheDocument()
  // The connection screen, then the way out. An offline page used to offer
  // only the way out.
  expect(screen.getByRole("link", { name: "connectionSettings" })).toHaveAttribute(
    "href",
    "/pair?mode=recover&state=offline"
  )
  expect(screen.getAllByRole("link")).toHaveLength(2)
})

const offlineCompanion = (connectionState: "offline" | "connecting" = "offline") => ({
  target: { id: "companion-studio", kind: "companion", hostKind: "desktop", platform: "mobile" },
  vaultState: "unlocked",
  connectionState,
})

it("says it is reconnecting, not that the Host is gone, while the link re-dials", () => {
  pathname = "/remote-sessions"
  snapshot = offlineCompanion("connecting")
  render(
    <SurfaceAvailabilityBoundary>
      <div>Remote sessions</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByTestId("surface-unavailable")).toHaveAttribute("data-state", "connecting")
  expect(screen.getByText("states.connecting")).toBeInTheDocument()
})

/**
 * The shell banner said "Reconnecting…" above a page saying "Host offline".
 * The blocked page is the connection report for its route, so it claims it.
 */
it("claims the connection report while an offline page stands in for the route", () => {
  pathname = "/remote-sessions"
  snapshot = offlineCompanion()
  const { unmount } = render(
    <SurfaceAvailabilityBoundary>
      <div>Remote sessions</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(isConnectionNoticeClaimed()).toBe(true)
  unmount()
  expect(isConnectionNoticeClaimed()).toBe(false)
})

it("does not claim the connection for a page blocked for another reason", () => {
  render(
    <SurfaceAvailabilityBoundary>
      <div>browser implementation</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByText("states.unsupported")).toBeInTheDocument()
  expect(isConnectionNoticeClaimed()).toBe(false)
})

/**
 * The phone's `OfflineBanner` is the one connection report and already says
 * "cached data only" on its own line; this band repeated it one row lower.
 */
it("leaves the cache fallback to the shell banner on the compact shell", () => {
  compact = true
  pathname = "/workflows"
  snapshot = offlineCompanion("connecting")
  render(
    <SurfaceAvailabilityBoundary>
      <div>workflow list</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.getByText("workflow list")).toBeInTheDocument()
})

it("keeps a read-only reason that is not about the connection on the compact shell", () => {
  compact = true
  pathname = "/logs"
  snapshot = {
    target: { id: "web-standalone", kind: "standalone", platform: "web" },
    vaultState: "unlocked",
    connectionState: "online",
  }
  render(
    <SurfaceAvailabilityBoundary>
      <div>logs</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByRole("status")).toHaveTextContent(
    "band.readOnly · reasons.operation-unavailable"
  )
})

/**
 * A compact route that scrolls as a document sits in a block column. The
 * desktop's flex row shrank its page to its content's width — the workflow
 * list stopped at ~80% of the phone screen while the Host was offline.
 */
it("gives a document-scrolling compact route a block slot, not a flex row", () => {
  compact = true
  pathname = "/workflows"
  snapshot = offlineCompanion()
  render(
    <SurfaceAvailabilityBoundary>
      <div>workflow list</div>
    </SurfaceAvailabilityBoundary>
  )
  const slot = screen.getByTestId("surface-read-only-slot")
  expect(slot).toHaveClass("min-w-0", "flex-1")
  expect(slot).not.toHaveClass("flex")
  // Not a scroll container: sticky headers inside measure against the page.
  expect(slot).not.toHaveClass("overflow-hidden")
})

it("keeps the stretching row for a compact route that owns the viewport", () => {
  compact = true
  pathname = "/"
  snapshot = offlineCompanion()
  render(
    <SurfaceAvailabilityBoundary>
      <div>chat</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByTestId("surface-read-only-slot")).toHaveClass("flex", "overflow-hidden")
})

it("lets the hub of settings render while its Host reconnects", () => {
  compact = true
  pathname = "/me"
  snapshot = offlineCompanion("connecting")
  render(
    <SurfaceAvailabilityBoundary>
      <div>me hub</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByText("me hub")).toBeInTheDocument()
  expect(screen.queryByTestId("surface-unavailable")).not.toBeInTheDocument()
})
