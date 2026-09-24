/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import type { AgentRuntimeDescriptor } from "@/lib/ai/agent/runtime-catalog/types"

jest.mock("@/hooks/agent/use-agent-runtime-catalog", () => ({
  useAgentRuntimeCatalog: jest.fn(),
}))

import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

import {
  deriveExternalRuntimeConnections,
  useExternalRuntimeConnections,
} from "./use-external-runtime-connections"

const catalogMock = useAgentRuntimeCatalog as jest.Mock

const builtin: AgentRuntimeDescriptor = {
  ref: { kind: "builtin" },
  key: "builtin",
  group: "builtin",
  nameKey: "cogniaAgent",
}
const pi: AgentRuntimeDescriptor = {
  ref: { kind: "external", agentId: "pi" },
  key: "external:pi",
  group: "external",
  name: "Pi",
  protocolLabel: "PI-RPC",
}
const codex: AgentRuntimeDescriptor = {
  ref: { kind: "external", agentId: "codex" },
  key: "external:codex",
  group: "external",
  name: "Codex",
  blockedReason: "codex binary not found",
}
const pluginAgent: AgentRuntimeDescriptor = {
  ref: { kind: "external", agentId: "plug" },
  key: "external:plug",
  group: "external",
  name: "Plugin agent",
  blockedReason: "adapter not registered yet",
  blockTransient: true,
}
const hostOnly: AgentRuntimeDescriptor = {
  ref: {
    kind: "host",
    configId: "h1",
    revision: "r1",
    lifecycleGeneration: 1,
    name: "Host Claude",
  },
  key: "host:h1",
  group: "host",
  placement: "host",
  name: "Host Claude",
}
const both: AgentRuntimeDescriptor = {
  ref: { kind: "host", configId: "h2", revision: "r2", lifecycleGeneration: 1, name: "Gemini" },
  key: "host:h2",
  group: "host",
  placement: "both",
  alternateRef: { kind: "external", agentId: "gemini" },
  name: "Gemini",
}

describe("deriveExternalRuntimeConnections", () => {
  it("drops the builtin lane and maps live connection status", () => {
    const result = deriveExternalRuntimeConnections({
      runtimes: [
        builtin,
        pi,
        { ...pi, ref: { kind: "external", agentId: "pi2" }, key: "external:pi2", name: "Pi 2" },
      ],
      connectionStatus: { pi: "connected", pi2: "reconnecting" },
      externalEnabled: true,
      configuredCount: 2,
    })
    expect(result.rows.map((row) => [row.key, row.state])).toEqual([
      ["external:pi", "connected"],
      ["external:pi2", "connecting"],
    ])
    expect(result.rows[0]).toMatchObject({
      name: "Pi",
      protocolLabel: "PI-RPC",
      placement: "local",
      localAgentId: "pi",
      detail: null,
    })
    expect(result.workingCount).toBe(1)
  })

  it("reports errors, disconnected agents, and blocks with their reason", () => {
    const result = deriveExternalRuntimeConnections({
      runtimes: [pi, codex, pluginAgent],
      connectionStatus: { pi: "error" },
      externalEnabled: true,
      configuredCount: 3,
    })
    expect(result.rows.map((row) => row.state)).toEqual(["error", "blocked", "checking"])
    expect(result.rows[1].detail).toBe("codex binary not found")
    expect(result.workingCount).toBe(0)
  })

  it("treats host-lane rows as ready and keeps the local id for the credential probe", () => {
    const result = deriveExternalRuntimeConnections({
      runtimes: [hostOnly, both],
      connectionStatus: {},
      externalEnabled: true,
      configuredCount: 1,
    })
    expect(result.rows).toEqual([
      expect.objectContaining({
        key: "host:h1",
        state: "ready",
        placement: "host",
        localAgentId: null,
      }),
      expect.objectContaining({
        key: "host:h2",
        state: "ready",
        placement: "both",
        localAgentId: "gemini",
      }),
    ])
    expect(result.workingCount).toBe(2)
  })

  it("surfaces a last-contact warning when nothing blocks the row", () => {
    const result = deriveExternalRuntimeConnections({
      runtimes: [{ ...pi, warning: "Needs sign-in" }],
      connectionStatus: {},
      externalEnabled: true,
      configuredCount: 1,
    })
    expect(result.rows[0]).toMatchObject({ state: "off", detail: "Needs sign-in" })
  })

  it("carries the master switch and configured count through", () => {
    const result = deriveExternalRuntimeConnections({
      runtimes: [builtin],
      connectionStatus: {},
      externalEnabled: false,
      configuredCount: 2,
    })
    expect(result).toEqual({
      externalEnabled: false,
      configuredCount: 2,
      rows: [],
      workingCount: 0,
    })
  })
})

describe("useExternalRuntimeConnections", () => {
  afterEach(() => {
    act(() => useExternalAgentStore.setState({ connectionStatus: {} }))
  })

  it("reads the runtime catalog and the store's connection status", () => {
    catalogMock.mockReturnValue({
      runtimes: [builtin, pi],
      selected: builtin,
      externalEnabled: true,
      configuredExternalCount: 1,
    })
    useExternalAgentStore.setState({ connectionStatus: { pi: "connected" } })
    const { result } = renderHook(() => useExternalRuntimeConnections())
    expect(result.current).toMatchObject({
      externalEnabled: true,
      configuredCount: 1,
      workingCount: 1,
      rows: [expect.objectContaining({ key: "external:pi", state: "connected" })],
    })
  })
})
