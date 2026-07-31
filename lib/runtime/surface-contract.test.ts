import fs from "node:fs"
import path from "node:path"

import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"
import type { RuntimeSnapshot } from "./operation-availability"
import {
  SURFACE_CONTRACTS,
  getSurfaceContract,
  getSurfaceContractForRoute,
  isInternalRouteExempt,
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
