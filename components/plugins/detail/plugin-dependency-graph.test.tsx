/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => []),
}))

import {
  PluginDependencyGraph,
  __resetPluginDependencyResolverForTests,
} from "./plugin-dependency-graph"

beforeEach(() => {
  __resetPluginDependencyResolverForTests(null)
})

describe("PluginDependencyGraph", () => {
  it("renders the root plugin id when there are no dependencies", async () => {
    __resetPluginDependencyResolverForTests({
      setInstalledPlugins: jest.fn(),
      resolve: async () => ({
        success: true,
        resolved: [],
        missing: [],
        conflicts: [],
        installOrder: [],
        warnings: [],
      }),
    })
    render(<PluginDependencyGraph manifest={{ id: "alpha" }} />)
    // A lone root is not a graph — the canvas is replaced by a plain sentence
    // rather than drawing a single node in an empty field.
    await waitFor(() => expect(screen.getByTestId("plugin-dependency-none")).toBeInTheDocument())
    expect(screen.queryByTestId("plugin-dependency-canvas")).not.toBeInTheDocument()
  })

  it("renders resolved + missing dependencies and the unresolved badge", async () => {
    __resetPluginDependencyResolverForTests({
      setInstalledPlugins: jest.fn(),
      resolve: async () => ({
        success: false,
        resolved: [
          {
            id: "@cognia/core",
            version: "1.0.0",
            constraint: "^1",
            satisfies: true,
            source: "installed",
          },
        ],
        missing: ["@external/lib"],
        conflicts: [],
        installOrder: [],
        warnings: [],
      }),
    })
    render(
      <PluginDependencyGraph
        manifest={{
          id: "alpha",
          dependencies: { "@cognia/core": "^1", "@external/lib": "*" },
        }}
      />
    )
    // Each id now appears twice: once as a graph node, once in the verdict
    // list below it, which is where the installed/marketplace/missing source
    // stays readable.
    await waitFor(() => expect(screen.getAllByText("@cognia/core").length).toBeGreaterThan(0))
    expect(screen.getAllByText("@external/lib").length).toBeGreaterThan(0)
    expect(screen.getByText("unresolved")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-dependency-canvas")).toBeInTheDocument()
  })

  it("draws a node for the root and for every dependency", async () => {
    __resetPluginDependencyResolverForTests({
      setInstalledPlugins: jest.fn(),
      resolve: async () => ({
        success: true,
        resolved: [
          { id: "a", version: "1.0.0", constraint: "^1", satisfies: true, source: "installed" },
          { id: "b", version: "2.0.0", constraint: "^2", satisfies: true, source: "installed" },
        ],
        missing: [],
        conflicts: [],
        installOrder: ["a", "b"],
        warnings: [],
      }),
    })
    render(<PluginDependencyGraph manifest={{ id: "alpha" }} />)
    await waitFor(() => expect(screen.getByTestId("rf__node-alpha")).toBeInTheDocument())
    expect(screen.getByTestId("rf__node-a")).toBeInTheDocument()
    expect(screen.getByTestId("rf__node-b")).toBeInTheDocument()
  })

  /** The arrangement carries the meaning, so a user must not scramble it. */
  it("renders the graph as non-draggable", async () => {
    __resetPluginDependencyResolverForTests({
      setInstalledPlugins: jest.fn(),
      resolve: async () => ({
        success: true,
        resolved: [
          { id: "a", version: "1.0.0", constraint: "^1", satisfies: true, source: "installed" },
        ],
        missing: [],
        conflicts: [],
        installOrder: ["a"],
        warnings: [],
      }),
    })
    render(<PluginDependencyGraph manifest={{ id: "alpha" }} />)
    await waitFor(() => expect(screen.getByTestId("rf__node-a")).toBeInTheDocument())
    expect(screen.getByTestId("rf__node-a").className).not.toContain("draggable")
  })

  it("surfaces conflicts with their reason text", async () => {
    __resetPluginDependencyResolverForTests({
      setInstalledPlugins: jest.fn(),
      resolve: async () => ({
        success: false,
        resolved: [],
        missing: [],
        conflicts: [
          {
            dependencyId: "@cognia/core",
            requiredBy: [],
            reason: "incompatible version",
          },
        ],
        installOrder: [],
        warnings: [],
      }),
    })
    render(<PluginDependencyGraph manifest={{ id: "alpha" }} />)
    await waitFor(() =>
      expect(screen.getByText("@cognia/core — incompatible version")).toBeInTheDocument()
    )
  })

  it("surfaces resolver warnings", async () => {
    __resetPluginDependencyResolverForTests({
      setInstalledPlugins: jest.fn(),
      resolve: async () => ({
        success: true,
        resolved: [],
        missing: [],
        conflicts: [],
        installOrder: [],
        warnings: ["legacy version detected"],
      }),
    })
    render(<PluginDependencyGraph manifest={{ id: "alpha" }} />)
    await waitFor(() => expect(screen.getByText("legacy version detected")).toBeInTheDocument())
  })

  it("renders an inline error if resolve throws", async () => {
    __resetPluginDependencyResolverForTests({
      setInstalledPlugins: jest.fn(),
      resolve: async () => {
        throw new Error("resolver crashed")
      },
    })
    render(<PluginDependencyGraph manifest={{ id: "alpha" }} />)
    await waitFor(() => expect(screen.getByText("resolver crashed")).toBeInTheDocument())
  })
})
