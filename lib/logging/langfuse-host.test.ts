jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn() },
}))

import { transport } from "@/lib/tauri/transport-instance"

import {
  clearLangfuseCredentials,
  getLangfuseCredentialsStatus,
  ingestLangfuseTraceBatch,
  setLangfuseCredentials,
  testLangfuseConnection,
} from "./langfuse-host"

const call = transport.call as jest.MockedFunction<typeof transport.call>

beforeEach(() => call.mockReset())

it("uses only the five narrow Langfuse Host commands", async () => {
  call.mockResolvedValue(undefined)
  const credentials = {
    enabled: true,
    baseUrl: "https://cloud.langfuse.com",
    publicKey: "pk-project",
    secretKey: "sk-project",
    environment: "test",
    captureModelContent: false,
    captureToolContent: true,
  }

  await setLangfuseCredentials(credentials)
  await getLangfuseCredentialsStatus()
  await clearLangfuseCredentials()
  await testLangfuseConnection()

  expect(call.mock.calls).toEqual([
    ["langfuse_credentials_set", credentials],
    ["langfuse_credentials_status", {}],
    ["langfuse_credentials_clear", {}],
    ["langfuse_connection_test", {}],
  ])
})

it("submits a versioned batch without endpoint, headers, or credentials", async () => {
  call.mockResolvedValue({ acceptedSpans: 0, duplicateSpans: 1, status: 202 })
  const batch = { schemaVersion: 1 as const, spans: [] }

  await ingestLangfuseTraceBatch(batch)

  expect(call).toHaveBeenCalledWith("langfuse_trace_ingest", { batch })
  expect(JSON.stringify(call.mock.calls[0])).not.toMatch(/secret|authorization|endpoint/i)
})
