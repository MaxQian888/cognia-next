/** @jest-environment jsdom */
import React, { Suspense, memo, type ReactNode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import {
  registerLinkMatchersForPlugin,
  unregisterLinkMatchersForPlugin,
} from "./link-matcher-bridge"
import {
  clearAllLinkMatchers,
  getLinkMatcher,
  listLinkMatchers,
  registerLinkMatcher,
} from "@/lib/plugin/api/link-matchers"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { LinkMatcherProps, PluginLinkMatcherDef } from "@/types/plugin/plugin-link-matcher"
import { loggers } from "@/lib/plugin/core/logger"

jest.mock("@/lib/plugin/core/logger", () => ({
  loggers: { manager: { error: jest.fn() } },
}))

const definition: PluginLinkMatcherDef = {
  id: "pull",
  patterns: ["github.com/**"],
  entry: "links.js",
  export: "Link",
}
const manifest = (defs: PluginLinkMatcherDef[] = [definition]): PluginManifest => ({
  id: "p",
  name: "P",
  version: "1.0.0",
  type: "frontend",
  description: "",
  main: "index.js",
  capabilities: ["link-matcher"],
  permissions: ["extension:ui"],
  linkMatchers: defs,
})
const Link = ({ href, children }: LinkMatcherProps) => <a href={href}>{children}</a>
const hasPermission = () => true

class Boundary extends React.Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <span>failed</span> : this.props.children
  }
}

function mountMatcher() {
  const Component = getLinkMatcher("https://github.com/org/repo")!.component
  return render(
    <Boundary>
      <Suspense fallback={<span>loading</span>}>
        <Component href="https://github.com/org/repo">Matched</Component>
      </Suspense>
    </Boundary>
  )
}

afterEach(() => {
  cleanup()
  unregisterLinkMatchersForPlugin("p")
  clearAllLinkMatchers()
  jest.restoreAllMocks()
})

it("imports only when a matching component renders and supports React wrappers", async () => {
  const importer = jest.fn(async () => ({ Link: memo(Link) }))
  const result = await registerLinkMatchersForPlugin(manifest(), "/plugins/p", {
    importer,
    hasPermission,
  })
  expect(result).toEqual({ registered: 1, errors: [] })
  expect(getLinkMatcher("https://example.com/")).toBeUndefined()
  expect(importer).not.toHaveBeenCalled()
  mountMatcher()
  expect(await screen.findByRole("link", { name: "Matched" })).toHaveAttribute(
    "href",
    "https://github.com/org/repo"
  )
  expect(importer).toHaveBeenCalledTimes(1)
  expect(importer).toHaveBeenCalledWith("/plugins/p/links.js")
})

it("preserves imperative activate registrations when registering or refreshing manifest entries", async () => {
  registerLinkMatcher("p", { id: "imperative", patterns: ["example.com/**"], component: Link })
  const options = { importer: jest.fn(async () => ({ Link })), hasPermission }
  await registerLinkMatchersForPlugin(manifest(), "/plugins/p", options)
  await registerLinkMatchersForPlugin(manifest(), "/plugins/p", options)
  expect(listLinkMatchers().map(({ id }) => id)).toEqual(["imperative", "pull"])
  await registerLinkMatchersForPlugin(manifest([]), "/plugins/p", options)
  expect(listLinkMatchers().map(({ id }) => id)).toEqual(["imperative"])
  unregisterLinkMatchersForPlugin("p")
  expect(listLinkMatchers()).toEqual([])
})

it.each([
  { id: "constructor" },
  { patterns: ["javascript:*"] },
  { patterns: [] },
  { priority: Infinity },
  { label: "" },
  { entry: "../escape.js" },
  { entry: "https://evil.com/link.js" },
  { export: "" },
  { export: "constructor" },
])("rejects invalid definitions before import: %s", async (invalid) => {
  const importer = jest.fn(async () => ({ Link }))
  const result = await registerLinkMatchersForPlugin(
    manifest([{ ...definition, ...invalid }]),
    "/plugins/p",
    { importer, hasPermission }
  )
  expect(result.registered).toBe(0)
  expect(result.errors).toHaveLength(1)
  expect(importer).not.toHaveBeenCalled()
  expect(listLinkMatchers()).toEqual([])
})

it("isolates malformed and duplicate entries and enforces the manifest permission gate", async () => {
  const importer = jest.fn(async () => ({ Link }))
  const denied = await registerLinkMatchersForPlugin(manifest(), "/plugins/p", {
    importer,
    hasPermission: () => false,
  })
  expect(denied.errors[0].message).toMatch(/extension:ui/)
  expect(listLinkMatchers()).toEqual([])
  const result = await registerLinkMatchersForPlugin(
    manifest([null as never, definition, definition]),
    "/plugins/p",
    { importer, hasPermission }
  )
  expect(result.registered).toBe(1)
  expect(result.errors).toHaveLength(2)
  expect(importer).not.toHaveBeenCalled()
})

it.each(["missing", "throws", "revoked"])(
  "reports lazy failures (%s) to host boundary and logs",
  async (failure) => {
    jest.spyOn(console, "error").mockImplementation(() => {})
    let allowed = true
    const importer = jest.fn(async () => {
      if (failure === "throws") throw new Error("network unavailable")
      return { Other: Link }
    })
    const result = await registerLinkMatchersForPlugin(manifest(), "/plugins/p", {
      importer,
      hasPermission: () => allowed,
    })
    if (failure === "revoked") allowed = false
    mountMatcher()
    expect(await screen.findByText("failed")).toBeInTheDocument()
    expect(result.errors).toHaveLength(1)
    expect(loggers.manager.error).toHaveBeenCalled()
    if (failure === "revoked") expect(importer).not.toHaveBeenCalled()
  }
)

it("cannot resurrect a registration when its pending import resolves after disable", async () => {
  let resolve!: (value: Record<string, unknown>) => void
  const importer = jest.fn(
    () =>
      new Promise<Record<string, unknown>>((done) => {
        resolve = done
      })
  )
  await registerLinkMatchersForPlugin(manifest(), "/plugins/p", { importer, hasPermission })
  const view = mountMatcher()
  expect(screen.getByText("loading")).toBeInTheDocument()
  unregisterLinkMatchersForPlugin("p")
  view.unmount()
  await act(async () => {
    resolve({ Link })
  })
  expect(listLinkMatchers()).toEqual([])
})
