/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ResolutionResult } from "@/lib/plugin/package/dependency-resolver"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (vars) return `${key}:${JSON.stringify(vars)}`
    return key
  },
}))

function resolveWith(result: ResolutionResult) {
  __resetPluginDependencyResolverForTests({
    setInstalledPlugins: jest.fn(),
    resolve: async () => result,
  })
}

async function openCanvas() {
  fireEvent.click(await screen.findByTestId("plugin-dependency-graph-toggle"))
}

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
    // The verdict and the list read without the canvas.
    await waitFor(() => expect(screen.getByText("@cognia/core")).toBeInTheDocument())
    expect(screen.getByText("@external/lib")).toBeInTheDocument()
    expect(screen.getByText("unresolved")).toBeInTheDocument()
    expect(screen.getByText("missingCount:1")).toBeInTheDocument()
    expect(screen.getByText('atVersion:{"version":"1.0.0"}')).toBeInTheDocument()
    expect(screen.getByText("source.installed")).toBeInTheDocument()
    // The costly canvas waits behind the disclosure.
    expect(screen.queryByTestId("plugin-dependency-canvas")).not.toBeInTheDocument()
    const toggle = screen.getByTestId("plugin-dependency-graph-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("showGraph")
    await openCanvas()
    expect(screen.getByTestId("plugin-dependency-canvas")).toBeInTheDocument()
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent("hideGraph")
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
    await openCanvas()
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
    await openCanvas()
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
    const line = await screen.findByText(
      'conflictLine:{"dependencyId":"@cognia/core","reason":"incompatible version"}'
    )
    // An inline callout with a left rule, not a nested card.
    const callout = line.closest("[role='group']") as HTMLElement
    expect(callout).toHaveClass("border-l-2", "border-destructive")
    expect(within(callout).getByText("conflictsTitle:1")).toBeInTheDocument()
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
    const warning = await screen.findByText("legacy version detected")
    expect(warning.closest("[role='group']")).toHaveClass("border-l-2", "border-amber-500")
  })

  it("caps a long dependency list, keeping missing rows first", async () => {
    resolveWith({
      success: false,
      resolved: Array.from({ length: 10 }, (_, i) => ({
        id: `dep-${i}`,
        version: "1.0.0",
        constraint: "^1",
        satisfies: true,
        source: "installed" as const,
      })),
      missing: ["gone"],
      conflicts: [],
      installOrder: [],
      warnings: [],
    })
    render(<PluginDependencyGraph manifest={{ id: "alpha" }} />)
    const list = await screen.findByRole("list", { name: "title" })
    const rows = within(list).getAllByRole("listitem")
    expect(rows).toHaveLength(8)
    expect(rows[0]).toHaveTextContent("gone")
    fireEvent.click(screen.getByRole("button", { name: "showAll:11" }))
    expect(within(list).getAllByRole("listitem")).toHaveLength(11)
  })

  it("draws no card or nested scroller", async () => {
    resolveWith({
      success: true,
      resolved: [
        { id: "a", version: "1.0.0", constraint: "^1", satisfies: true, source: "installed" },
      ],
      missing: [],
      conflicts: [],
      installOrder: ["a"],
      warnings: [],
    })
    const { container } = render(<PluginDependencyGraph manifest={{ id: "alpha" }} />)
    await screen.findByText("allResolved")
    expect(screen.getByTestId("plugin-dependency-graph")).toHaveClass("@container")
    expect(container.querySelector("[data-slot='card']")).toBeNull()
    expect(container.querySelector("[class*='max-h-']")).toBeNull()
    expect(screen.getByTestId("plugin-dependency-graph-toggle")).toHaveClass("pointer-coarse:h-10")
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
