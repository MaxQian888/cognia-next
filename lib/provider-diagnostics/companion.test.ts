/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { addPairedDevice, setRemoteControlAllowed } from "@/lib/db/paired-devices"
import { getDb } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { useAccountStore } from "@/stores/account/account-store"

import {
  getRemoteProviderDiagnosticsHistory,
  getRemoteProviderDiagnosticsStatus,
  startRemoteProviderDiagnostics,
} from "./companion"

jest.mock("./targets", () => ({
  resolveProviderDiagnosticTargets: jest.fn(async ({ providerId, capability }) => [
    {
      id: `${providerId}:configured`,
      providerId,
      modelId: "configured-model",
      credentialFingerprint: `credential:${providerId}:primary`,
      endpoint: "https://configured.example/v1",
      capability,
      credentials: { apiKey: "secret", baseURL: "https://configured.example/v1" },
      billable: capability !== "probe",
      estimatedMaxCostUsd: capability === "probe" ? 0 : 0.01,
    },
  ]),
}))

jest.mock("./service", () => ({
  startProviderDiagnosticJob: jest.fn(async () => ({ id: "started" })),
  cancelProviderDiagnosticJob: jest.fn(() => true),
}))

beforeEach(async () => {
  useAccountStore.setState({ loaded: true, locked: false })
  const db = getDb()
  await Promise.all([
    db.pairedDevices.clear(),
    db.providerDiagnosticJobs.clear(),
    db.providerDiagnosticSamples.clear(),
    db.providerBalanceSnapshots.clear(),
  ])
  await addPairedDevice({
    deviceId: "device-1",
    label: "Phone",
    platform: "ios",
    pubkey: "key",
    appVersion: "1",
  })
  await setRemoteControlAllowed("device-1", true)
})

it("returns sanitized status and history projections", async () => {
  await getDb().providerDiagnosticJobs.put({
    id: "job-1",
    providerId: "openai",
    mode: "quick",
    capability: "probe",
    status: "completed",
    targetCount: 1,
    completedCount: 1,
    requestLimit: 50,
    maxEstimatedCostUsd: 0.25,
    startedAt: 10,
    completedAt: 20,
    remoteAudit: {
      deviceId: "device-1",
      requestedAt: 10,
      confirmedRequestLimit: 1,
      confirmedMaxEstimatedCostUsd: 0,
    },
  })
  await getDb().providerDiagnosticSamples.put({
    id: "sample-1",
    jobId: "job-1",
    targetId: "target-1",
    providerId: "openai",
    credentialFingerprint: "credential:openai:primary",
    endpoint: "https://endpoint.example/v1",
    capability: "probe",
    promptVersion: "probe-v1",
    sampleRole: "measured",
    status: "completed",
    startedAt: 10,
  })
  await getDb().providerBalanceSnapshots.put({
    id: "balance-1",
    providerId: "openai",
    sourceId: "official",
    credentialFingerprint: "credential:openai:primary",
    amounts: [{ unit: "USD", remaining: 8 }],
    fetchedAt: 30,
    staleAt: 60,
  })

  const status = (await getRemoteProviderDiagnosticsStatus({
    callerDeviceId: "device-1",
  })) as {
    jobs: Array<Record<string, unknown>>
    balanceSnapshots: Array<Record<string, unknown>>
    balanceSources: Array<Record<string, unknown>>
    stale: boolean
  }
  const history = (await getRemoteProviderDiagnosticsHistory({
    callerDeviceId: "device-1",
  })) as { samples: Array<Record<string, unknown>> }

  expect(status.stale).toBe(false)
  expect(status.jobs[0]).not.toHaveProperty("remoteAudit")
  expect(status.balanceSnapshots).toEqual([
    expect.objectContaining({ sourceId: "official", amounts: [{ unit: "USD", remaining: 8 }] }),
  ])
  expect(status.balanceSources).toEqual([
    expect.objectContaining({ id: "official", kind: "declarative", label: "official" }),
  ])
  expect(history.samples[0]).not.toHaveProperty("endpoint")
})

it("rejects arbitrary endpoint and credential material", async () => {
  await expect(
    startRemoteProviderDiagnostics({
      callerDeviceId: "device-1",
      targets: [
        {
          providerId: "openai",
          capability: "probe",
          endpoint: "https://attacker.example",
          credentialId: "stolen",
        },
      ],
      confirmedRequestLimit: 1,
      confirmedMaxEstimatedCostUsd: 0,
    })
  ).rejects.toThrow("forbidden fields")
})

it("requires desktop opt-in and confirmation for paid jobs", async () => {
  const settings = await getSettings()
  await saveSettings({
    ...settings,
    providerDiagnostics: { ...settings.providerDiagnostics!, remotePaidDiagnosticsEnabled: false },
  })
  await expect(
    startRemoteProviderDiagnostics({
      callerDeviceId: "device-1",
      targets: [{ providerId: "openai", modelId: "gpt", capability: "text-generation" }],
      confirmedRequestLimit: 1,
      confirmedMaxEstimatedCostUsd: 0.1,
      costConfirmed: true,
    })
  ).rejects.toThrow("disabled")
})

it("denies a paired device without the remote-control grant", async () => {
  await setRemoteControlAllowed("device-1", false)
  await expect(getRemoteProviderDiagnosticsStatus({ callerDeviceId: "device-1" })).rejects.toThrow(
    "not permitted"
  )
})
