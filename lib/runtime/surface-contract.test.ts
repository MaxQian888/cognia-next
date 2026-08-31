import fs from "node:fs"
import path from "node:path"

import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"
import type { RuntimeSnapshot } from "./operation-availability"
import { resolveRuntimeRecovery } from "./recovery-resolver"
import {
  SURFACE_CONTRACTS,
  getSurfaceContract,
  getSurfaceContractForRoute,
  isInternalRouteExempt,
  resolveSurfaceAvailability,
  shouldShowSurface,
} from "./surface-contract"

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    target: { id: "web-standalone", kind: "standalone", platform: "web" },
    vaultState: "unlocked",
    connectionState: "online",
    ...overrides,
  }
}

it("classifies every public sidebar destination exactly once", () => {
  expect(SURFACE_CONTRACTS.map((contract) => contract.id).sort()).toEqual(
    expect.arrayContaining(SIDEBAR_NAV_META.map((item) => item.id))
  )
  expect(
    SURFACE_CONTRACTS.filter((contract) => "navigation" in contract && contract.navigation)
      .map((contract) => contract.id)
      .sort()
  ).toEqual(SIDEBAR_NAV_META.map((item) => item.id).sort())
  expect(new Set(SURFACE_CONTRACTS.map((contract) => contract.id)).size).toBe(
    SURFACE_CONTRACTS.length
  )
})

it("classifies every app page or names it in the internal-route exemption list", () => {
  const appRoot = path.join(process.cwd(), "app")
  const pageRoutes = fs
    .readdirSync(appRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "page.tsx")
    .map((entry) => {
      const relative = path.relative(appRoot, path.join(entry.parentPath, entry.name))
      const segments = relative
        .split(path.sep)
        .slice(0, -1)
        .filter((segment) => !segment.startsWith("("))
      return segments.length ? `/${segments.join("/")}` : "/"
    })

  const unclassified = pageRoutes.filter(
    (route) => !getSurfaceContractForRoute(route) && !isInternalRouteExempt(route)
  )
  expect(unclassified).toEqual([])
})

it("hides host-only surfaces in standalone while keeping their deep-link contract", () => {
  const browser = getSurfaceContract("browser")
  expect(browser).not.toBeNull()
  expect(shouldShowSurface(browser!, snapshot())).toBe(false)
  expect(browser?.route).toBe("/browser")
  expect(browser?.standalone).toBe("hidden")
})

it("shows a host surface only when the Companion advertises the operation", () => {
  const browser = getSurfaceContract("browser")!
  const companion = snapshot({
    target: { id: "desktop", kind: "companion", hostKind: "desktop", platform: "web" },
    host: {
      compatible: true,
      operations: ["browser_session_ensure"],
      grants: ["agent.run"],
    },
  })

  expect(shouldShowSurface(browser, companion)).toBe(true)
  expect(
    shouldShowSurface(browser, {
      ...companion,
      host: { ...companion.host!, operations: [] },
    })
  ).toBe(false)
})

describe("resolveSurfaceAvailability reads the contract's companion column", () => {
  const unpaired = (): RuntimeSnapshot =>
    snapshot({
      target: { id: "desktop", kind: "companion", hostKind: "desktop", platform: "web" },
      vaultState: "unavailable",
      connectionState: "connecting",
    })

  it("lets a self-contained companion-full surface render without a host", () => {
    // These are how a companion ACQUIRES a host. Gating them on having one is a
    // closed loop: the remedy for `requires-pairing` links to `/pair`. What
    // earns the exemption is `offline: "local"` — needing nothing else at all.
    for (const id of ["pair", "onboarding"]) {
      const contract = getSurfaceContract(id)
      expect(contract).not.toBeNull()
      expect(contract!.companion).toBe("full")
      expect(contract!.offline).toBe("local")
      expect(resolveSurfaceAvailability(contract!, unpaired())).toEqual({
        state: "available",
        reason: "local-executor",
      })
    }
  })

  it("still gates a companion-full surface that declares a host dependency", () => {
    // `companion: "full"` alone is not the question. `/servers` and
    // `/share/view` declare `offline: "cached-read"` precisely BECAUSE they
    // read through the host — the Ops Controller's credentials come out of the
    // vault — so exempting them reported a locked vault and a dead connection
    // as `available` and made their own `cached-read` column unreachable.
    for (const id of ["servers", "share-view"]) {
      const contract = getSurfaceContract(id)
      expect(contract).not.toBeNull()
      expect(contract!.companion).toBe("full")
      expect(contract!.offline).toBe("cached-read")
      expect(resolveSurfaceAvailability(contract!, unpaired())).toEqual({
        state: "requires-pairing",
        reason: "companion-not-paired",
      })
      expect(
        resolveSurfaceAvailability(
          contract!,
          snapshot({
            target: { id: "desktop", kind: "companion", hostKind: "desktop", platform: "web" },
            vaultState: "locked",
          })
        )
      ).toEqual({ state: "requires-unlock", reason: "vault-locked" })
      // And the column they declare is reachable again.
      expect(
        resolveSurfaceAvailability(
          contract!,
          snapshot({
            target: { id: "desktop", kind: "companion", hostKind: "desktop", platform: "web" },
            connectionState: "offline",
          })
        )
      ).toEqual({ state: "read-only", reason: "offline-cache" })
    }
  })

  it("still walls off a companion-remote surface when there is no pairing", () => {
    const chat = getSurfaceContract("chat")!
    expect(chat.companion).toBe("remote")
    expect(resolveSurfaceAvailability(chat, unpaired())).toEqual({
      state: "requires-pairing",
      reason: "companion-not-paired",
    })
  })

  it("still walls off a companion-remote surface when the vault is locked", () => {
    const chat = getSurfaceContract("chat")!
    expect(resolveSurfaceAvailability(chat, { ...unpaired(), vaultState: "locked" })).toEqual({
      state: "requires-unlock",
      reason: "vault-locked",
    })
  })

  it("keeps a companion-full surface reachable through a locked vault too", () => {
    const pair = getSurfaceContract("pair")!
    expect(resolveSurfaceAvailability(pair, { ...unpaired(), vaultState: "locked" })).toEqual({
      state: "available",
      reason: "local-executor",
    })
  })
})

it("closes the pairing loop instead of pointing at a page that refuses to render", () => {
  // The remedy for `requires-pairing` is a link to /pair. Before the companion
  // column was read, /pair resolved to `requires-pairing` itself, so the only
  // exit refused to render for exactly the state it exists to fix.
  const unpaired: RuntimeSnapshot = snapshot({
    target: { id: "desktop", kind: "companion", hostKind: "desktop", platform: "web" },
    vaultState: "unavailable",
    connectionState: "connecting",
  })

  const chat = resolveSurfaceAvailability(getSurfaceContract("chat")!, unpaired)
  expect(chat.state).toBe("requires-pairing")

  const recovery = resolveRuntimeRecovery(chat, "web")
  expect(recovery).toEqual({ kind: "route", href: "/pair?mode=add" })

  // …and the page that link leads to actually renders.
  expect(resolveSurfaceAvailability(getSurfaceContract("pair")!, unpaired).state).toBe("available")
})

/**
 * `/me/terminal` had no row and therefore inherited `/me`'s, which classifies
 * the profile hub. A terminal is a process on a machine, so `standalone:
 * "full"` was the one answer that could not be true of it, and the boundary
 * never classified the route at all.
 */
describe("/me/terminal", () => {
  it("is matched by its own contract rather than the /me hub's", () => {
    const contract = getSurfaceContractForRoute("/me/terminal")
    expect(contract?.id).toBe("me-terminal")
    expect(getSurfaceContractForRoute("/me")?.id).toBe("me")
  })

  /**
   * The shell is never the machine running the shell. Pairing one is what
   * changes that, and `unsupported` is the state whose recovery is `/pair`.
   */
  it("sends a standalone browser to pairing instead of a dead screen", () => {
    const contract = getSurfaceContract("me-terminal")
    expect(contract).not.toBeNull()
    expect(resolveSurfaceAvailability(contract!, snapshot())).toEqual({
      state: "unsupported",
      reason: "requires-companion",
    })
  })

  /** A pty is a live process. There is no cached reading of one. */
  it("is blocked offline rather than served from a cache", () => {
    expect(getSurfaceContract("me-terminal")?.offline).toBe("blocked")
  })

  /** It is reached from the `/me` list, not the sidebar, so it claims no nav slot. */
  it("claims no navigation slot of its own", () => {
    expect(getSurfaceContract("me-terminal")).not.toHaveProperty("navigation")
  })
})
