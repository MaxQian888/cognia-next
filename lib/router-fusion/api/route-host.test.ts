import type { AppSettings } from "@cognia/agent-config-types"

const createChatRouteHostMock = jest.fn((input: Record<string, unknown>) => ({
  settings: { marker: "from-chat-route-host" },
  engineDeps: input.engineDeps,
  planRoute: async () => ({ marker: "planned" }),
  currentSettings: () => undefined,
  now: () => 0,
  newId: () => "id",
}))
jest.mock("../chat/chat-route-host", () => ({
  createChatRouteHost: (input: Record<string, unknown>) => createChatRouteHostMock(input),
}))

class FakeEngine {
  constructor(
    readonly registry: unknown,
    readonly config: unknown,
    readonly deps: unknown
  ) {}
}
jest.mock("@cognia/provider-routing", () => ({
  ProviderRoutingEngine: class {
    constructor(registry: unknown, config: unknown, deps: unknown) {
      return new FakeEngine(registry, config, deps)
    }
  },
  createMappingRegistry: (mappings: unknown) => ({ mappings }),
}))
jest.mock("@cognia/provider-routing/build-preview-engine", () => ({
  buildRoutingEngineDeps: (settings: unknown) => ({ builtFrom: settings }),
}))

import { createRunApiRouteHost } from "./route-host"

const SNAPSHOT = {
  modelMappings: [{ id: "m1" }],
  routingConfig: { marker: "routing-config" },
} as unknown as AppSettings

beforeEach(() => createChatRouteHostMock.mockClear())

describe("createRunApiRouteHost", () => {
  it("routes against the user's own providers, through one engine built from the snapshot", () => {
    const host = createRunApiRouteHost(SNAPSHOT)
    expect(createChatRouteHostMock).toHaveBeenCalledTimes(1)
    const input = createChatRouteHostMock.mock.calls[0][0] as {
      appSettings: AppSettings
      engine: FakeEngine
      engineDeps: unknown
    }
    expect(input.appSettings).toBe(SNAPSHOT)
    expect(input.engineDeps).toEqual({ builtFrom: SNAPSHOT })
    expect(input.engine).toBeInstanceOf(FakeEngine)
    expect(input.engine.registry).toEqual({ mappings: SNAPSHOT.modelMappings })
    expect(input.engine.config).toBe(SNAPSHOT.routingConfig)
    // The engine deps the host reports are the ones the engine plans with.
    expect(host.engineDeps).toEqual({ builtFrom: SNAPSHOT })
    // No host-side surface: `routeRunRequest` books a Run API classification
    // on `gatewayRuns`, not on chat.
    expect(host.surface).toBeUndefined()
  })

  it("answers the live check from the snapshot, because a headless brain loads no settings store", () => {
    const host = createRunApiRouteHost(SNAPSHOT)
    expect(host.currentSettings()).toBe(SNAPSHOT)
  })

  it("falls back to the default routing config and an empty mapping set", () => {
    createRunApiRouteHost({} as AppSettings)
    const input = createChatRouteHostMock.mock.calls[0][0] as { engine: FakeEngine }
    expect(input.engine.registry).toEqual({ mappings: [] })
    expect(input.engine.config).toBeDefined()
  })
})
