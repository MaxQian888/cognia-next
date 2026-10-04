/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"
import type { InstalledAgentRuntimes } from "@/hooks/agent/use-installed-agent-runtimes"
import type { ProcessPlaneUnavailableReason } from "@/lib/ai/agent/external/capability/process-plane"
import type { InstalledRuntime } from "@/lib/ai/agent/external/config/installed-runtimes"
import type { ExternalAgentPresetConfig } from "@/lib/ai/agent/external/config/presets"

import { DETECTION_UNAVAILABLE_KEYS, PLANE_WARNING_KEYS, PresetGuidance } from "./preset-guidance"

const manager = en.externalAgent.manager as unknown as Record<string, unknown>
const unavailableCopy = manager.detectionUnavailable as Record<string, string>

const REASONS: ProcessPlaneUnavailableReason[] = [
  "no-host",
  "manifest-missing",
  "unsupported",
  "not-granted",
]

function preset(overrides: Partial<ExternalAgentPresetConfig> = {}): ExternalAgentPresetConfig {
  return {
    name: "Sample",
    description: "Sample agent",
    protocol: "acp",
    transport: "stdio",
    defaultPermissionMode: "default",
    tags: [],
    ...overrides,
  }
}

function detection(overrides: Partial<InstalledAgentRuntimes> = {}): InstalledAgentRuntimes {
  return {
    loading: false,
    unavailable: null,
    runtimes: [],
    forPreset: () => undefined,
    refresh: jest.fn(),
    ...overrides,
  }
}

describe("PresetGuidance", () => {
  it("renders the support tier, docs link and setup hint when the preset has them", () => {
    render(
      <PresetGuidance
        presetId="sample"
        preset={preset({
          supportTier: "executable",
          docsUrl: "https://example.com/docs",
          setupHint: "Install the sample CLI first.",
        })}
        detection={detection()}
      />
    )

    // The tier id is wire vocabulary; the badge shows its translated label.
    expect(screen.getByText(en.externalAgent.supportTier.executable)).toBeInTheDocument()
    expect(screen.queryByText("executable")).not.toBeInTheDocument()
    const link = screen.getByRole("link", { name: manager.officialDocs as string })
    expect(link).toHaveAttribute("href", "https://example.com/docs")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer")
    expect(screen.getByText("Install the sample CLI first.")).toBeInTheDocument()
  })

  it("uses the translated setup hint for a catalogued preset", () => {
    render(
      <PresetGuidance
        presetId="devin"
        preset={preset({ setupHint: "English preset prose" })}
        detection={detection()}
      />
    )
    expect(screen.getByText(manager.devinSetupHint as string)).toBeInTheDocument()
    expect(screen.queryByText("English preset prose")).not.toBeInTheDocument()
  })

  it("omits tier, docs, setup hint and env note when the preset has none", () => {
    render(<PresetGuidance presetId="sample" preset={preset()} detection={detection()} />)

    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.queryByText(`${manager.noteLabel as string}:`)).not.toBeInTheDocument()
    expect(screen.getByTestId("preset-guidance").querySelector(".bg-amber-50")).toBeNull()
  })

  it("renders the env var note in the amber box only when present", () => {
    render(
      <PresetGuidance
        presetId="sample"
        preset={preset({ envVarHint: "Set SAMPLE_API_KEY." })}
        detection={detection()}
      />
    )
    const note = screen.getByText(`${manager.noteLabel as string}:`).parentElement
    expect(note).toHaveClass("bg-amber-50")
    expect(note).toHaveTextContent("Set SAMPLE_API_KEY.")
  })

  it("says detection is running while loading, and hides the unavailable line", () => {
    render(
      <PresetGuidance
        presetId="sample"
        preset={preset()}
        detection={detection({ loading: true, unavailable: "no-host" })}
      />
    )
    expect(screen.getByText(manager.detectionRunning as string)).toBeInTheDocument()
    expect(screen.queryByText(unavailableCopy.noHost)).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: manager.detectionRetry as string })
    ).not.toBeInTheDocument()
  })

  it.each([...REASONS, "failed" as const])(
    "explains unavailable detection (%s) and retries through refresh",
    async (reason) => {
      const user = userEvent.setup()
      const refresh = jest.fn()
      render(
        <PresetGuidance
          presetId="sample"
          preset={preset()}
          detection={detection({ unavailable: reason, refresh })}
        />
      )

      expect(
        screen.getByText(unavailableCopy[DETECTION_UNAVAILABLE_KEYS[reason]]!)
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: manager.detectionRetry as string }))
      expect(refresh).toHaveBeenCalledTimes(1)
    }
  )

  it("renders the runtime detection badge for the preset's row", () => {
    const row: InstalledRuntime = {
      runtimeId: "sample",
      command: "sample",
      resolution: "installed",
      executablePath: null,
      version: "1.2.3",
      detail: null,
    }
    const forPreset = jest.fn((id: string) => (id === "sample" ? row : undefined))
    const { container } = render(
      <PresetGuidance presetId="sample" preset={preset()} detection={detection({ forPreset })} />
    )

    expect(forPreset).toHaveBeenCalledWith("sample")
    const badge = container.querySelector('[data-detection="installed"]')
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent("1.2.3")
  })

  it("renders no detection badge when nothing is known", () => {
    const { container } = render(
      <PresetGuidance presetId="sample" preset={preset()} detection={detection()} />
    )
    expect(container.querySelector("[data-detection]")).toBeNull()
  })

  it("lists the other official surfaces of the same product", () => {
    render(
      <PresetGuidance
        presetId="codex"
        preset={preset({ adapterId: "codex", surfaceId: "acp-stdio" })}
        detection={detection()}
      />
    )
    expect(screen.getByText(manager.otherOfficialSurfaces as string)).toBeInTheDocument()
  })
})

describe("reason tables", () => {
  it("PLANE_WARNING_KEYS covers every process-plane reason", () => {
    expect(Object.keys(PLANE_WARNING_KEYS).sort()).toEqual([...REASONS].sort())
  })

  it("DETECTION_UNAVAILABLE_KEYS covers every reason plus failed", () => {
    expect(Object.keys(DETECTION_UNAVAILABLE_KEYS).sort()).toEqual([...REASONS, "failed"].sort())
  })

  it.each([
    ["en", en],
    ["zh-CN", zh],
  ])("has a distinct detection-unavailable message for each key in %s", (_locale, bundle) => {
    const copy = (bundle.externalAgent.manager as unknown as Record<string, unknown>)
      .detectionUnavailable as Record<string, string>
    const messages = Object.values(DETECTION_UNAVAILABLE_KEYS).map((key) => copy[key])
    for (const message of messages) {
      expect(typeof message).toBe("string")
      expect(message!.length).toBeGreaterThan(0)
    }
    expect(new Set(messages).size).toBe(messages.length)
  })

  it.each([
    ["en", en],
    ["zh-CN", zh],
  ])("has a process-plane warning for each mapped key in %s", (_locale, bundle) => {
    const copy = (bundle.externalAgent.manager as unknown as Record<string, unknown>)
      .processPlaneWarning as Record<string, string>
    for (const key of Object.values(PLANE_WARNING_KEYS)) {
      expect(typeof copy[key]).toBe("string")
      expect(copy[key]!.length).toBeGreaterThan(0)
    }
  })
})
