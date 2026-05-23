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
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument())
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
    await waitFor(() => expect(screen.getByText("@cognia/core")).toBeInTheDocument())
    expect(screen.getByText("@external/lib")).toBeInTheDocument()
    expect(screen.getByText("unresolved")).toBeInTheDocument()
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
