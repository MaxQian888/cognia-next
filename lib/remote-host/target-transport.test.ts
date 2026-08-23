/** @jest-environment jsdom */

import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import type { Transport } from "@/lib/tauri/transport-types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { openRemoteHostTarget } from "./target-transport"

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
  expect(loadCredential).not.toHaveBeenCalled()
  target.close()
  expect(destroy).toHaveBeenCalledTimes(1)
})
