/**
 * @jest-environment node
 *
 * The production wiring, which the port-injecting tests in `service.test.ts`
 * deliberately never touch.
 *
 * This codebase has a standing failure mode with the injected-deps pattern:
 * every test supplies stubs, so `createDefaultLifecycleDependencies` — the only
 * version that runs in the app — is the one path nothing exercises. A store
 * that loses `patchLifecycle`, or a manager whose shape drifts from
 * `LifecycleRuntimeManager`, would break the feature while the whole suite
 * stayed green.
 */

const storeState = {
  getAgent: jest.fn(() => ({ id: "agent-1" })),
  getAllAgents: jest.fn(() => []),
  addAgent: jest.fn(() => "agent-1"),
  updateAgent: jest.fn(),
  removeAgent: jest.fn(),
  replaceAgentConfig: jest.fn(),
  patchLifecycle: jest.fn(),
  setConnectionStatus: jest.fn(),
}

const managerInstance = {
  addAgent: jest.fn(),
  removeAgent: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  getAgent: jest.fn(),
  closeSession: jest.fn(),
}

const registryHas = jest.fn(() => true)
const createKeyringStore = jest.fn((_namespace: string) => ({
  save: jest.fn(),
  load: jest.fn(),
  delete: jest.fn(),
}))
const getDeviceId = jest.fn(async () => "device-abc")

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: { getState: () => storeState },
}))
jest.mock("../manager", () => ({
  getExternalAgentManager: () => managerInstance,
}))
jest.mock("../protocol-adapter", () => ({
  protocolAdapterRegistry: { has: registryHas },
}))
jest.mock("@/lib/credentials/keyring-store", () => ({
  createKeyringStore: (namespace: string) => createKeyringStore(namespace),
}))
jest.mock("@/lib/device/device-identity", () => ({
  getDeviceId: () => getDeviceId(),
}))

import { EXTERNAL_AGENT_SECURITY_POLICY_VERSION } from "../security-policy"
import { EXTERNAL_AGENT_KEYRING_NAMESPACE } from "./credentials"
import {
  ExternalAgentLifecycleService,
  __resetLifecycleServiceForTests,
  createDefaultLifecycleDependencies,
  getExternalAgentLifecycleService,
} from "./service"

beforeEach(() => {
  jest.clearAllMocks()
  getDeviceId.mockResolvedValue("device-abc")
  __resetLifecycleServiceForTests()
})

describe("createDefaultLifecycleDependencies", () => {
  it("wires every store port to the real store action of the same name", async () => {
    const deps = await createDefaultLifecycleDependencies()

    deps.store.getAgent("a")
    deps.store.getAllAgents()
    deps.store.addAgent({ name: "n", protocol: "acp", transport: "stdio" })
    deps.store.updateAgent("a", { name: "x" })
    deps.store.removeAgent("a")
    deps.store.replaceAgentConfig("a", { id: "a" } as never)
    deps.store.patchLifecycle("a", { lifecycleStatus: "ready" })
    deps.store.setConnectionStatus("a", "connected")

    expect(storeState.getAgent).toHaveBeenCalledWith("a")
    expect(storeState.getAllAgents).toHaveBeenCalled()
    expect(storeState.addAgent).toHaveBeenCalled()
    expect(storeState.updateAgent).toHaveBeenCalledWith("a", { name: "x" })
    expect(storeState.removeAgent).toHaveBeenCalledWith("a")
    expect(storeState.replaceAgentConfig).toHaveBeenCalledWith("a", { id: "a" })
    // The port the store did not have before this change.
    expect(storeState.patchLifecycle).toHaveBeenCalledWith("a", { lifecycleStatus: "ready" })
    expect(storeState.setConnectionStatus).toHaveBeenCalledWith("a", "connected")
  })

  it("reads store state per call, so it never captures a stale snapshot", async () => {
    const deps = await createDefaultLifecycleDependencies()
    storeState.getAgent.mockReturnValueOnce({ id: "first" })
    expect(deps.store.getAgent("x")).toEqual({ id: "first" })
    storeState.getAgent.mockReturnValueOnce({ id: "second" })
    expect(deps.store.getAgent("x")).toEqual({ id: "second" })
  })

  it("uses the process-wide runtime manager", async () => {
    const deps = await createDefaultLifecycleDependencies()
    expect(deps.manager).toBe(managerInstance)
  })

  it("asks the live adapter registry, so a disabled plugin is seen immediately", async () => {
    const deps = await createDefaultLifecycleDependencies()
    registryHas.mockReturnValueOnce(false)
    expect(deps.adapters.isProtocolAvailable("plugin:x")).toBe(false)
    expect(registryHas).toHaveBeenCalledWith("plugin:x")
  })

  it("opens the keyring under the external-agent namespace", async () => {
    await createDefaultLifecycleDependencies()
    expect(createKeyringStore).toHaveBeenCalledWith(EXTERNAL_AGENT_KEYRING_NAMESPACE)
  })

  it("binds consent to the security policy revision actually in force", async () => {
    const deps = await createDefaultLifecycleDependencies()
    expect(deps.policyRevision).toBe(EXTERNAL_AGENT_SECURITY_POLICY_VERSION)
  })

  it("uses the device identity as the host id", async () => {
    const deps = await createDefaultLifecycleDependencies()
    expect(deps.hostId).toBe("device-abc")
  })

  it("falls back to a per-process host id so stored consent fails its host check", async () => {
    getDeviceId.mockResolvedValue(null as unknown as string)
    const first = await createDefaultLifecycleDependencies()
    const second = await createDefaultLifecycleDependencies()

    expect(first.hostId).toMatch(/^ephemeral:/)
    // Distinct per call: a consent recorded under one can never validate later.
    expect(first.hostId).not.toBe(second.hostId)
  })

  it("reports this host's platform and a usable clock", async () => {
    const deps = await createDefaultLifecycleDependencies()
    expect(deps.platform).toBe(process.platform)
    expect(deps.now()).toBeInstanceOf(Date)
  })

  it("leaves the runtime host absent until a host implements it", async () => {
    const deps = await createDefaultLifecycleDependencies()
    // Honest absence: install/uninstall refuse with `platform_unsupported`
    // rather than pretending to have run.
    expect(deps.runtimeHost).toBeUndefined()
  })
})

describe("getExternalAgentLifecycleService", () => {
  it("returns one shared service", async () => {
    const first = await getExternalAgentLifecycleService()
    const second = await getExternalAgentLifecycleService()
    expect(first).toBeInstanceOf(ExternalAgentLifecycleService)
    expect(second).toBe(first)
  })

  it("rebuilds after a reset", async () => {
    const first = await getExternalAgentLifecycleService()
    __resetLifecycleServiceForTests()
    expect(await getExternalAgentLifecycleService()).not.toBe(first)
  })
})
