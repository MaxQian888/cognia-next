/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Keep the registry off the network in every test in this file.
jest.mock("@/lib/mcp/registry/client", () => ({ searchRegistry: jest.fn() }))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { searchRegistry } from "@/lib/mcp/registry/client"
import type { McpPreset } from "@/lib/claude/mcp-presets"
import { McpPresetGrid } from "./mcp-preset-grid"
import {
  __resetMcpServerPresetsForTesting,
  registerMcpServerPreset,
} from "@/lib/plugin/registries/mcp-server-preset-registry"

const searchRegistryMock = searchRegistry as jest.MockedFunction<typeof searchRegistry>

beforeEach(() => {
  __resetMcpServerPresetsForTesting()
  searchRegistryMock.mockReset()
  searchRegistryMock.mockResolvedValue({ presets: [], nextCursor: null })
})

function registryPreset(overrides: Partial<McpPreset> = {}): McpPreset {
  return {
    id: "remote-thing",
    name: "Remote Thing",
    description: "A server from the registry.",
    icon: "🛰️",
    transport: "http",
    config: { url: "https://x/mcp" },
    fields: [],
    tags: ["registry"],
    ...overrides,
  }
}

describe("McpPresetGrid", () => {
  it("renders preset cards and filters by search", () => {
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    expect(screen.getByText("Filesystem")).toBeInTheDocument()
    expect(screen.getByText("GitHub")).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("search"), { target: { value: "github" } })
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.queryByText("Filesystem")).not.toBeInTheDocument()
  })

  it("drops into the configure step for presets that need fields", () => {
    const onPresetSelected = jest.fn()
    render(<McpPresetGrid existingNames={[]} onPresetSelected={onPresetSelected} />)
    fireEvent.click(screen.getByText("Filesystem"))
    // Filesystem requires an "Allowed directory" arg, so we land on configure.
    expect(screen.getByTestId("mcp-preset-configure")).toBeInTheDocument()
    // Submit is disabled until the required field is filled.
    const submit = screen.getByText("addServer")
    expect(submit).toBeDisabled()
  })

  it("submits the configure step with entered values", () => {
    const onPresetSelected = jest.fn()
    render(<McpPresetGrid existingNames={[]} onPresetSelected={onPresetSelected} />)
    fireEvent.click(screen.getByText("Filesystem"))
    const input = screen.getByPlaceholderText("/Users/me/projects")
    fireEvent.change(input, { target: { value: "/tmp" } })
    fireEvent.click(screen.getByText("addServer"))
    expect(onPresetSelected).toHaveBeenCalledTimes(1)
    expect(onPresetSelected.mock.calls[0][1]).toMatchObject({ PATH: "/tmp" })
  })

  it("disables presets whose name is already taken", () => {
    render(<McpPresetGrid existingNames={["github"]} onPresetSelected={jest.fn()} />)
    expect(screen.getByText("GitHub").closest("button")).toBeDisabled()
  })

  it("submits immediately for a field-less preset", () => {
    const onPresetSelected = jest.fn()
    render(<McpPresetGrid existingNames={[]} onPresetSelected={onPresetSelected} />)
    fireEvent.click(screen.getByText("Playwright"))
    expect(onPresetSelected).toHaveBeenCalledTimes(1)
    expect(onPresetSelected.mock.calls[0][1]).toEqual({})
    // Stays on the grid (no configure step).
    expect(screen.queryByTestId("mcp-preset-configure")).not.toBeInTheDocument()
  })

  it("returns to the grid from the configure step via Back", () => {
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    fireEvent.click(screen.getByText("Filesystem"))
    expect(screen.getByTestId("mcp-preset-configure")).toBeInTheDocument()
    fireEvent.click(screen.getByText("back"))
    expect(screen.getByTestId("mcp-preset-grid")).toBeInTheDocument()
  })

  it("renders enabled plugin-contributed presets", () => {
    registerMcpServerPreset(
      "figma-local",
      {
        id: "figma-local",
        name: "Figma Desktop",
        transport: "http",
        config: { url: "http://127.0.0.1:3845/mcp" },
      },
      { pluginId: "figma" }
    )
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    expect(screen.getByText("Figma Desktop")).toBeInTheDocument()
  })
})

describe("McpPresetGrid — official registry search", () => {
  function typeQuery(value: string) {
    fireEvent.change(screen.getByPlaceholderText("search"), { target: { value } })
  }

  it("does not hit the registry for a query shorter than two characters", async () => {
    jest.useFakeTimers()
    try {
      render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
      typeQuery("g")
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })
      expect(searchRegistryMock).not.toHaveBeenCalled()
      expect(screen.queryByTestId("mcp-registry-results")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("searches the registry after the debounce and renders the results", async () => {
    searchRegistryMock.mockResolvedValue({ presets: [registryPreset()], nextCursor: null })
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    typeQuery("remote")

    await waitFor(() => expect(searchRegistryMock).toHaveBeenCalled())
    expect(searchRegistryMock.mock.calls[0][0]).toMatchObject({ search: "remote" })
    expect(await screen.findByText("Remote Thing")).toBeInTheDocument()
  })

  it("debounces to a single request while the user is still typing", async () => {
    jest.useFakeTimers()
    try {
      render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
      typeQuery("gi")
      typeQuery("git")
      typeQuery("gith")
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })
      expect(searchRegistryMock).toHaveBeenCalledTimes(1)
      expect(searchRegistryMock.mock.calls[0][0]).toMatchObject({ search: "gith" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("shows an inline notice when the registry is unreachable", async () => {
    searchRegistryMock.mockRejectedValue(new Error("offline"))
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    typeQuery("remote")
    expect(await screen.findByText("registryError")).toBeInTheDocument()
  })

  it("reports when the registry has no match", async () => {
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    typeQuery("zzzznope")
    expect(await screen.findByText("registryEmpty")).toBeInTheDocument()
  })

  it("adds a field-less registry server straight away", async () => {
    const onPresetSelected = jest.fn()
    searchRegistryMock.mockResolvedValue({ presets: [registryPreset()], nextCursor: null })
    render(<McpPresetGrid existingNames={[]} onPresetSelected={onPresetSelected} />)
    typeQuery("remote")

    fireEvent.click(await screen.findByText("Remote Thing"))
    expect(onPresetSelected).toHaveBeenCalledTimes(1)
    expect(onPresetSelected.mock.calls[0][0]).toMatchObject({ id: "remote-thing" })
  })

  it("routes a registry server with fields through the configure step", async () => {
    searchRegistryMock.mockResolvedValue({
      presets: [
        registryPreset({
          fields: [{ key: "API_KEY", label: "API key", placement: "env", secret: true }],
        }),
      ],
      nextCursor: null,
    })
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    typeQuery("remote")

    fireEvent.click(await screen.findByText("Remote Thing"))
    expect(screen.getByTestId("mcp-preset-configure")).toBeInTheDocument()
  })

  it("suppresses registry results while a tag filter is active", async () => {
    jest.useFakeTimers()
    try {
      render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
      typeQuery("dev")
      fireEvent.click(screen.getByText("dev"))
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })
      expect(screen.queryByTestId("mcp-registry-results")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })
})
