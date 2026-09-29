/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import type { VideoGenerationSettings } from "@cognia/agent-config-types"

const saveMock = jest.fn()
let currentSettings: Record<string, unknown> = {}
let nativeReach = true

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (state: { settings: Record<string, unknown>; save: jest.Mock }) => unknown
  ) => selector({ settings: currentSettings, save: saveMock }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/lib/network/platform-fetch", () => ({
  reachesNonCorsHosts: () => nativeReach,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

// Radix Select does not open in jsdom; a native select keeps the options and
// their disabled state inspectable.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react") as typeof import("react")
  type Option = { value: string; label: string; disabled?: boolean }
  const collect = (node: React.ReactNode, sink: { label?: string; options: Option[] }) => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return
      const props = child.props as {
        children?: React.ReactNode
        value?: string
        disabled?: boolean
        "aria-label"?: string
      }
      const kind = (child.type as { displayName?: string }).displayName
      if (kind === "Trigger") sink.label = props["aria-label"]
      if (kind === "Item") {
        sink.options.push({
          value: props.value ?? "",
          label: String(props.children),
          disabled: props.disabled,
        })
        return
      }
      collect(props.children, sink)
    })
  }
  const Trigger = (_: { children?: React.ReactNode }) => null
  Trigger.displayName = "Trigger"
  const Item = (_: { value: string; children: React.ReactNode }) => null
  Item.displayName = "Item"
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => {
    const sink: { label?: string; options: Option[] } = { options: [] }
    collect(children, sink)
    return (
      <select aria-label={sink.label} value={value} onChange={(e) => onValueChange(e.target.value)}>
        {sink.options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: Trigger,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectItem: Item,
  }
})

import { VideoGenerationCard } from "./video-generation-card"

function saved(): VideoGenerationSettings {
  return saveMock.mock.calls.at(-1)?.[0]?.videoGeneration
}

function withProviders(
  videoGeneration: Partial<VideoGenerationSettings> = {},
  providers: Record<string, unknown> = {
    doubao: { enabled: true, apiKey: "ark" },
    qwen: { enabled: true, apiKey: "dash" },
  }
) {
  currentSettings = { providerSettings: providers, videoGeneration }
}

beforeEach(() => {
  jest.clearAllMocks()
  currentSettings = {}
  nativeReach = true
})

describe("VideoGenerationCard", () => {
  it("points to AI connections when no video provider is configured", () => {
    render(<VideoGenerationCard />)
    expect(screen.getByText("noProviders")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "openConnections" })).toHaveAttribute(
      "href",
      expect.stringContaining("section=ai-connections")
    )
    expect(screen.queryByRole("combobox", { name: "provider" })).not.toBeInTheDocument()
  })

  it("lists only configured providers, after the automatic choice", () => {
    withProviders()
    render(<VideoGenerationCard />)
    const provider = screen.getByRole("combobox", { name: "provider" })
    const values = Array.from((provider as HTMLSelectElement).options).map((o) => o.value)
    expect(values).toEqual(["__auto__", "doubao", "qwen"])
    expect(screen.getByText("optionsNeedProvider")).toBeInTheDocument()
  })

  it("lists providers the browser cannot reach as inert", () => {
    nativeReach = false
    withProviders(
      {},
      { doubao: { enabled: true, apiKey: "a" }, google: { enabled: true, apiKey: "g" } }
    )
    render(<VideoGenerationCard />)
    const options = Array.from(
      (screen.getByRole("combobox", { name: "provider" }) as HTMLSelectElement).options
    )
    expect(options.find((o) => o.value === "doubao")?.disabled).toBe(true)
    expect(options.find((o) => o.value === "doubao")?.textContent).toContain("desktopRequired")
    expect(options.find((o) => o.value === "google")?.disabled).toBe(false)
    expect(screen.getByText("webNote")).toBeInTheDocument()
  })

  it("starts a new provider from its own defaults", () => {
    withProviders({ providerId: "doubao", model: "seedance-1-0-pro-250528", durationSec: 5 })
    render(<VideoGenerationCard />)
    fireEvent.change(screen.getByRole("combobox", { name: "provider" }), {
      target: { value: "qwen" },
    })
    expect(saved()).toEqual({ agentTool: true, providerId: "qwen" })
  })

  it("offers only the options the provider takes", () => {
    withProviders({ providerId: "qwen" })
    render(<VideoGenerationCard />)
    expect(screen.getByRole("combobox", { name: "options.durationSec" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "options.resolution" })).toBeInTheDocument()
    // DashScope Wan drops an aspect ratio (it sizes from the resolution).
    expect(screen.queryByRole("combobox", { name: "options.aspectRatio" })).not.toBeInTheDocument()
  })

  it("saves a chosen option and clears it back to the provider default", () => {
    withProviders({ providerId: "doubao", durationSec: 5 })
    render(<VideoGenerationCard />)
    const duration = screen.getByRole("combobox", { name: "options.durationSec" })
    fireEvent.change(duration, { target: { value: "10" } })
    expect(saved()).toEqual({ agentTool: true, providerId: "doubao", durationSec: 10 })
    fireEvent.change(duration, { target: { value: "__auto__" } })
    expect(saved()).toEqual({ agentTool: true, providerId: "doubao" })
  })

  it("says when the chosen model needs a start image", () => {
    withProviders({ providerId: "qwen", model: "wan2.6-i2v" })
    render(<VideoGenerationCard />)
    expect(screen.getByText("modelNeedsImage")).toBeInTheDocument()
  })

  it("flags a saved provider that is no longer configured and lets it be dropped", () => {
    withProviders({ providerId: "google", model: "veo-3.1-generate-preview", durationSec: 8 })
    render(<VideoGenerationCard />)
    expect(screen.getByText(/savedProviderGone/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "clearSavedProvider" }))
    expect(saved()).toEqual({ agentTool: true })
  })

  it("keeps a saved model the list does not carry selectable", () => {
    withProviders({ providerId: "doubao", model: "seedance-custom-1" })
    render(<VideoGenerationCard />)
    const model = screen.getByRole("combobox", { name: "model" }) as HTMLSelectElement
    expect(model.value).toBe("seedance-custom-1")
  })

  it("switches the agent tool off and on", () => {
    withProviders()
    render(<VideoGenerationCard />)
    fireEvent.click(screen.getByRole("switch", { name: "agentTool" }))
    expect(saved()).toEqual({ agentTool: false })
  })
})
