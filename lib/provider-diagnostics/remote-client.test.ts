/**
 * @jest-environment jsdom
 */

import type { Transport } from "@/lib/tauri/transport-types"

import {
  cancelRemoteProviderDiagnosticJob,
  fetchRemoteProviderDiagnosticsHistory,
  fetchRemoteProviderDiagnosticsStatus,
  getCachedRemoteProviderDiagnosticsStatus,
  startRemoteProviderDiagnosticJob,
} from "./remote-client"

function mockTransport(call: jest.Mock): Transport {
  return { call, subscribe: jest.fn(() => jest.fn()) }
}

beforeEach(() => localStorage.clear())

it("caches sanitized status per paired desktop and marks offline data stale", async () => {
  const online = mockTransport(
    jest.fn(async () => ({
      capturedAt: 10,
      desktopRevision: 9,
      stale: false,
      jobs: [],
      balanceSnapshots: [],
      balanceSources: [],
    }))
  )
  await fetchRemoteProviderDiagnosticsStatus("openai", {
    transport: online,
    cacheScope: "desktop-a",
  })

  const offline = mockTransport(jest.fn(async () => Promise.reject(new Error("offline"))))
  await expect(
    fetchRemoteProviderDiagnosticsStatus("openai", {
      transport: offline,
      cacheScope: "desktop-a",
    })
  ).resolves.toMatchObject({ capturedAt: 10, desktopRevision: 9, stale: true })
  expect(getCachedRemoteProviderDiagnosticsStatus("openai", { cacheScope: "desktop-b" })).toBeNull()
})

it("caches history without inventing an endpoint and bounds the requested limit", async () => {
  const call = jest.fn(async () => ({
    capturedAt: 20,
    desktopRevision: 19,
    stale: false,
    samples: [{ id: "sample-1", providerId: "openai" }],
  }))
  const result = await fetchRemoteProviderDiagnosticsHistory(
    { providerId: "openai", limit: 999 },
    { transport: mockTransport(call), cacheScope: "desktop-a" }
  )

  expect(call).toHaveBeenCalledWith("provider_diagnostics_history", {
    providerId: "openai",
    limit: 200,
  })
  expect(result.samples[0]).not.toHaveProperty("endpoint")
})

it("forwards only the constrained remote start and cancel contracts", async () => {
  const call = jest
    .fn()
    .mockResolvedValueOnce({ accepted: true, jobId: "job-1" })
    .mockResolvedValueOnce({ cancelled: true })
  const remote = mockTransport(call)
  const input = {
    targets: [{ providerId: "openai", modelId: "gpt-5", capability: "text-generation" as const }],
    mode: "quick" as const,
    costConfirmed: true,
    confirmedRequestLimit: 1,
    confirmedMaxEstimatedCostUsd: 0.01,
  }

  await startRemoteProviderDiagnosticJob(input, { transport: remote })
  await cancelRemoteProviderDiagnosticJob("job-1", { transport: remote })

  expect(call).toHaveBeenNthCalledWith(1, "provider_diagnostics_start", input)
  expect(call).toHaveBeenNthCalledWith(2, "provider_diagnostics_cancel", { jobId: "job-1" })
})
