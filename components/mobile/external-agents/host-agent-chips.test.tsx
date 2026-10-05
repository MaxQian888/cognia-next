/** @jest-environment jsdom */

import { render, renderHook, screen } from "@testing-library/react"

import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import { HostAgentIsolationChip, useRuntimeName } from "./host-agent-chips"

function record(config: Partial<ExternalAgentConfigRecord["config"]>): ExternalAgentConfigRecord {
  return {
    configId: "eac_1",
    revision: "r",
    lifecycleGeneration: 1,
    seq: 1,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: { name: "A", protocol: "acp", transport: "stdio", ...config },
  } as ExternalAgentConfigRecord
}

describe("HostAgentIsolationChip", () => {
  it("says own state for an isolated configuration", () => {
    render(<HostAgentIsolationChip record={record({ stateIsolation: "isolated" })} />)
    expect(screen.getByTestId("host-agent-isolation-eac_1")).toHaveTextContent("Own state")
  })

  // Absent means shared: every configuration saved before isolation existed.
  it("says shared state when the field is absent", () => {
    render(<HostAgentIsolationChip record={record({})} />)
    const chip = screen.getByTestId("host-agent-isolation-eac_1")
    expect(chip).toHaveTextContent("Shared state")
    expect(chip).toHaveAttribute("data-isolation", "shared")
  })
})

describe("useRuntimeName", () => {
  it("names a preset runtime by its preset, a custom one by its command", () => {
    const { result } = renderHook(() => useRuntimeName())
    expect(result.current({ kind: "preset", id: "codex", key: "preset:codex" }, "x")).toBe(
      getPresetConfig("codex")!.name
    )
    expect(result.current({ kind: "preset", id: "gone", key: "preset:gone" }, "x")).toBe("gone")
    expect(result.current({ kind: "command", command: "pi", key: "command:pi" }, "x")).toBe("pi")
    expect(result.current({ kind: "single", key: "config:a" }, "Mine")).toBe("Mine")
  })
})
