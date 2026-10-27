/** @jest-environment jsdom */

import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"
import type { InstalledRuntime } from "@/lib/ai/agent/external/config/installed-runtimes"
import { PresetPickerList } from "./preset-picker-list"

const detections: Record<string, InstalledRuntime> = {}
const detectionState: { loading: boolean; unavailable: string | null } = {
  loading: false,
  unavailable: null,
}

jest.mock("@/hooks/agent/use-installed-agent-runtimes", () => ({
  useInstalledAgentRuntimes: jest.fn(() => ({
    loading: detectionState.loading,
    unavailable: detectionState.unavailable,
    runtimes: [],
    forPreset: (id: string) => detections[id],
  })),
}))

jest.mock("@/lib/ai/agent/external/config/presets", () => {
  const actual = jest.requireActual("@/lib/ai/agent/external/config/presets")
  return {
    ...actual,
    getPresetConfig: jest.fn(actual.getPresetConfig),
    resolvePreferredCodexExecutablePresetId: jest.fn(async () => "codex-app-server"),
  }
})

function renderPicker(props: Partial<React.ComponentProps<typeof PresetPickerList>> = {}) {
  const onPick = jest.fn()
  render(
    <TooltipProvider>
      <PresetPickerList onPick={onPick} {...props} />
    </TooltipProvider>
  )
  return { onPick }
}

beforeEach(() => {
  detectionState.loading = false
  detectionState.unavailable = null
  for (const id of Object.keys(detections)) delete detections[id]
  detections["claude-code"] = {
    runtimeId: "claude-code",
    command: "claude",
    resolution: "installed",
    executablePath: "/usr/local/bin/claude",
    version: "1.0.0",
    detail: null,
  }
})

afterEach(async () => {
  await act(async () => {
    await Promise.resolve()
  })
})

describe("PresetPickerList", () => {
  it("groups detected presets first and preserves detection while searching multiple terms", () => {
    renderPicker()
    const installed = screen.getByTestId("preset-group-installed")
    expect(within(installed).getByTestId("preset-pick-claude-code")).toBeInTheDocument()
    expect(
      within(screen.getByTestId("preset-group-available")).queryByTestId("preset-pick-claude-code")
    ).toBeNull()
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  CLAUDE  code  " } })
    expect(screen.getByTestId("preset-group-installed")).toContainElement(
      screen.getByTestId("preset-pick-claude-code")
    )
    expect(screen.queryByTestId("preset-pick-codex")).toBeNull()
  })

  it("draws nothing for an unknown detection and never claims a runtime is missing", () => {
    renderPicker()
    const row = screen.getByTestId("preset-pick-codex")
    expect(row.querySelector("[data-detection]")).toBeNull()
    expect(
      screen.getByTestId("preset-pick-claude-code").querySelector('[data-detection="installed"]')
    ).toBeInTheDocument()
    expect(screen.queryByTestId("preset-detection-unavailable")).toBeNull()
    expect(screen.queryByTestId("preset-detection-checking")).toBeNull()
  })

  it("says once that detection is running, instead of on every row", () => {
    detectionState.loading = true
    renderPicker()
    expect(screen.getByTestId("preset-detection-checking")).toHaveAttribute("role", "status")
  })

  it("says once when this device cannot check installed runtimes", () => {
    detectionState.unavailable = "unsupported"
    renderPicker()
    expect(screen.getByTestId("preset-detection-unavailable")).toBeInTheDocument()
    expect(screen.getByTestId("preset-pick-codex").querySelector("[data-detection]")).toBeNull()
  })

  it("keeps experimental presets hidden until requested, then explains why they cannot be picked", async () => {
    const { onPick } = renderPicker()
    expect(screen.queryByTestId("preset-pick-opencode-remote")).toBeNull()
    await userEvent.click(screen.getByRole("switch", { name: "Show experimental" }))
    const row = screen.getByTestId("preset-pick-opencode-remote")
    expect(screen.getByTestId("preset-group-experimental")).toContainElement(row)
    expect(row).toBeDisabled()
    expect(row).toHaveAccessibleDescription()
    await userEvent.click(row)
    expect(onPick).not.toHaveBeenCalled()
  })

  it.each(["opencode-server", "opencode-v2-service"])(
    "keeps executable OpenCode compatibility route %s selectable",
    async (id) => {
      const { onPick } = renderPicker()
      const row = screen.getByTestId(`preset-pick-${id}`)
      expect(row).toBeEnabled()
      await userEvent.click(row)
      expect(onPick).toHaveBeenCalledWith(id)
    }
  )

  it("marks only the preferred Codex executable preset as recommended", async () => {
    renderPicker()
    expect(await screen.findByTestId("preset-recommended-codex-app-server")).toHaveTextContent(
      "Recommended"
    )
    expect(screen.queryByTestId("preset-recommended-codex")).toBeNull()
  })

  it.each([
    ["kimi", "Kimi subscription login"],
    ["cline", "Plan/Act"],
    ["qoder", "Qoder Personal Access Token"],
    ["aider", "Run the official Aider CLI"],
    ["goose", "Run Goose over native ACP"],
  ])("preserves localized guidance and picking for %s", async (id, description) => {
    const { onPick } = renderPicker()
    const row = screen.getByTestId(`preset-pick-${id}`)
    expect(row).toHaveTextContent(description)
    expect(row).toHaveTextContent("Runs directly")
    await userEvent.click(row)
    expect(onPick).toHaveBeenCalledWith(id)
  })

  it("supports arrow navigation between selectable rows and native Enter / Space picking", async () => {
    const { onPick } = renderPicker()
    const first = screen.getByTestId("preset-pick-claude-code")
    first.focus()
    await userEvent.keyboard("{ArrowUp}")
    expect(screen.getByTestId("preset-pick-custom")).toHaveFocus()
    await userEvent.keyboard(" ")
    expect(onPick).toHaveBeenLastCalledWith("custom")
    await userEvent.keyboard("{ArrowDown}{Enter}")
    expect(first).toHaveFocus()
    expect(onPick).toHaveBeenLastCalledWith("claude-code")
    await userEvent.keyboard("{ArrowDown}")
    expect(
      within(screen.getByTestId("preset-group-available")).getAllByRole("button")[0]
    ).toHaveFocus()
  })

  it("shows the empty search state and keeps custom configuration reachable", async () => {
    const { onPick } = renderPicker()
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing-matches" } })
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.queryByTestId("preset-group-available")).toBeNull()
    await userEvent.click(screen.getByTestId("preset-pick-custom"))
    expect(onPick).toHaveBeenCalledWith("custom")
  })

  it("does not assume plugin presets carry tags", () => {
    const mockGetPresetConfig = jest.mocked(getPresetConfig)
    const actual = jest.requireActual<typeof import("@/lib/ai/agent/external/config/presets")>(
      "@/lib/ai/agent/external/config/presets"
    )
    mockGetPresetConfig.mockImplementation((id) => {
      const preset = actual.getPresetConfig(id)
      return preset ? ({ ...preset, tags: undefined } as unknown as typeof preset) : null
    })
    renderPicker()
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "codex" } })
    expect(screen.getByTestId("preset-pick-codex")).toBeInTheDocument()
    mockGetPresetConfig.mockImplementation(actual.getPresetConfig)
  })

  it("disables search, the experimental switch, and every pick while disabled", () => {
    renderPicker({ disabled: true })
    expect(screen.getByRole("searchbox")).toBeDisabled()
    expect(screen.getByRole("switch")).toBeDisabled()
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled()
  })

  it("optionally focuses the search field", () => {
    renderPicker({ autoFocusSearch: true })
    expect(screen.getByRole("searchbox")).toHaveFocus()
  })
})
