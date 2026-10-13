/** @jest-environment jsdom */

const mockImportSigningPrivateKey = jest.fn(async (..._args: unknown[]) => ({ imported: true }))
jest.mock("@/lib/signaling/crypto", () => ({
  importSigningPrivateKey: (...args: unknown[]) => mockImportSigningPrivateKey(...args),
}))

import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import type { Transport } from "@/lib/tauri/transport-types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import {
  isPairedHostTargetCurrent,
  openRemoteHostTarget,
  pairedHostIdOf,
  type PairedHostTargetDeps,
} from "./target-transport"

const transport: Transport = {
  call: jest.fn(),
  subscribe: jest.fn(() => () => undefined),
}

beforeEach(() => {
  useRemoteHostStore.setState({
    activeHostId: null,
    hosts: [
      {
        id: "local-row",
        label: "Cloud",
        credentialRef: "remote-host:local-row",
        addedAt: 1,
        connectionState: "ready",
        config: {
          baseUrl: "https://cloud.example",
          deviceId: "controller-device",
          deviceKeyThumbprint: "thumb",
          serverVersion: "1.2.3",
          serverFingerprint: "sha256:server",
        },
        featureManifest: {
          schemaVersion: 2,
          hostBuildId: "1.2.3",
          platform: "headless",
          generatedAt: 1,
          hostIdentity: { id: "stable-cloud-id", kind: "cloud" },
          protocol: { min: 1, max: 2 },
          operations: [],
          deviceGrants: ["workflow.run"],
          features: { "workflow.execution": { version: 1, operations: [] } },
          limits: {
            rpcJsonBodyBytes: 64 * 1024,
            skillMaxResources: 50,
            skillMaxResourceBytes: 1,
            skillUploadChunkBytes: 1,
            mcpRequestBodyBytes: 1,
            maxConcurrentProxyCalls: 1,
          },
        },
      },
    ],
  })
})

it("opens an isolated transport by stable Host identity without switching the active Host", async () => {
  const createTransport = jest.fn((_provider: () => CompanionConfig) => transport)
  const target = await openRemoteHostTarget("stable-cloud-id", {
    loadCredential: jest.fn(async () => ({
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
    })),
    createTransport,
  })

  expect(target.host.id).toBe("local-row")
  expect(createTransport.mock.calls[0]?.[0]().devicePrivateKeyJwk?.d).toBe("private")
  expect(useRemoteHostStore.getState().activeHostId).toBeNull()
  target.close()
})

it("fails closed when the stable identity has no usable credential", async () => {
  await expect(
    openRemoteHostTarget("stable-cloud-id", {
      loadCredential: jest.fn(async () => null),
      createTransport: jest.fn(),
    })
  ).rejects.toThrow("credential is unavailable")
})

it("fails closed when the stable Host identity is not configured", async () => {
  await expect(
    openRemoteHostTarget("missing-host", {
      loadCredential: jest.fn(),
      createTransport: jest.fn(),
    })
  ).rejects.toThrow("is not configured")
})

it("uses an inline credential and disposes the isolated transport", async () => {
  const destroy = jest.fn()
  const inlineTransport = { ...transport, destroy }
  useRemoteHostStore.setState((state) => ({
    hosts: state.hosts.map((host) => ({
      ...host,
      config: {
        ...host.config,
        devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "inline-private" },
        signalingPrivateKeyJwk: { kty: "EC", crv: "P-256", d: "signal-private" },
      },
    })),
  }))
  const loadCredential = jest.fn()
  const createTransport = jest.fn((_provider: () => CompanionConfig) => inlineTransport)

  const target = await openRemoteHostTarget("local-row", { loadCredential, createTransport })
  const config = createTransport.mock.calls[0]?.[0]()

  expect(config?.devicePrivateKeyJwk?.d).toBe("inline-private")
  expect(config?.signalingPrivateKeyJwk?.d).toBe("signal-private")
  // ADR-0224 A4: the relay route signs with a CryptoKey, so an always-on host
  // only the relay reaches can still be managed.
  expect(mockImportSigningPrivateKey).toHaveBeenCalledWith({
    kty: "EC",
    crv: "P-256",
    d: "signal-private",
  })
  expect(config?.signalingPrivateKey).toMatchObject({ imported: true })
  expect(loadCredential).not.toHaveBeenCalled()
  target.close()
  expect(destroy).toHaveBeenCalledTimes(1)
})

it("keeps the direct route when the signaling key will not import", async () => {
  mockImportSigningPrivateKey.mockRejectedValueOnce(new Error("bad key"))
  const createTransport = jest.fn((_provider: () => CompanionConfig) => transport)
  await openRemoteHostTarget("local-row", {
    loadCredential: jest.fn(async () => ({
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      signalingPrivateKeyJwk: { kty: "EC", crv: "P-256", d: "bad" },
    })),
    createTransport,
  })
  const config = createTransport.mock.calls[0]?.[0]()
  expect(config?.devicePrivateKeyJwk?.d).toBe("private")
  expect(config?.signalingPrivateKey).toBeUndefined()
})

describe("the /pair Host this app is connected to", () => {
  const appTransport: Transport = { call: jest.fn(), subscribe: jest.fn(() => () => undefined) }
  const liveConfig: CompanionConfig = {
    targetId: "box",
    baseUrl: "https://127.0.0.1:27890",
    deviceId: "phone-device",
    deviceKeyThumbprint: "thumb",
    serverVersion: "0.1.0",
    devicePrivateKeyJwk: { kty: "EC", d: "secret" },
    signalingPrivateKeyJwk: { kty: "EC", d: "signing-secret" },
    serviceToken: "service",
  }
  const record = {
    hostId: "box",
    accountNamespace: "acct",
    label: "Cognia云主机",
    createdAt: 42,
  }
  const paired = (over: Partial<PairedHostTargetDeps> = {}): PairedHostTargetDeps => ({
    activeTarget: () => ({ accountId: "acct", targetId: "box" }),
    loadRecord: async () => record as never,
    loadConfig: () => liveConfig,
    transport: () => appTransport,
    ...over,
  })

  it("reads the Host id out of a companion ref, and nothing else", () => {
    expect(pairedHostIdOf("companion:box")).toBe("box")
    expect(pairedHostIdOf("companion:")).toBeNull()
    expect(pairedHostIdOf("local-row")).toBeNull()
  })

  it("borrows the app's own connection, never closes it, and keeps the keys out", async () => {
    const target = await openRemoteHostTarget("companion:box", { paired: paired() })
    expect(target.transport).toBe(appTransport)
    expect(target.host).toMatchObject({
      id: "companion:box",
      label: "Cognia云主机",
      addedAt: 42,
      connectionState: "ready",
      config: { deviceId: "phone-device", targetId: "box" },
    })
    for (const secret of [
      "devicePrivateKeyJwk",
      "signalingPrivateKeyJwk",
      "signalingPrivateKey",
      "serviceToken",
    ]) {
      expect(target.host.config).not.toHaveProperty(secret)
    }
    target.close()
    // The store path's transports are destroyed on close; this one is the app's.
    expect(appTransport).not.toHaveProperty("destroy")
  })

  it("refuses a /pair Host the app is not connected to, or one no longer paired", async () => {
    await expect(openRemoteHostTarget("companion:other", { paired: paired() })).rejects.toThrow(
      "not the Host this app is connected to"
    )
    await expect(
      openRemoteHostTarget("companion:box", {
        paired: paired({ loadConfig: () => ({ ...liveConfig, targetId: "elsewhere" }) }),
      })
    ).rejects.toThrow("not the Host this app is connected to")
    await expect(
      openRemoteHostTarget("companion:box", { paired: paired({ activeTarget: () => null }) })
    ).rejects.toThrow("not the Host this app is connected to")
    await expect(
      openRemoteHostTarget("companion:box", { paired: paired({ loadRecord: async () => null }) })
    ).rejects.toThrow("not paired")
  })

  it("is current only while the app is still connected to it with the same pairing", () => {
    expect(isPairedHostTargetCurrent("box", "phone-device", paired())).toBe(true)
    expect(isPairedHostTargetCurrent("box", undefined, paired())).toBe(true)
    expect(isPairedHostTargetCurrent("box", "old-device", paired())).toBe(false)
    expect(
      isPairedHostTargetCurrent(
        "box",
        "phone-device",
        paired({ activeTarget: () => ({ accountId: "acct", targetId: "desk" }) })
      )
    ).toBe(false)
  })
})
