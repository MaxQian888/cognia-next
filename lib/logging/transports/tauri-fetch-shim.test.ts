/** @jest-environment jsdom */

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))

import { invoke } from "@tauri-apps/api/core"
import {
  configureTauriSidecarTelemetry,
  createTauriOtlpFetch,
  postTauriTelemetryJson,
} from "./tauri-fetch-shim"

const invokeMock = invoke as jest.MockedFunction<typeof invoke>

describe("createTauriOtlpFetch", () => {
  beforeEach(() => invokeMock.mockReset())

  it("forwards the body and non-sensitive headers through telemetry_otlp_export", async () => {
    invokeMock.mockResolvedValue({ status: 202, accepted: true })
    const fetchImpl = createTauriOtlpFetch({
      credential: { kind: "grafanaCloud", instanceId: "1234567" },
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    })

    const response = await fetchImpl("https://collector.example/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tenant": "prod" },
      body: '{"resourceSpans":[]}',
    })

    expect(response.status).toBe(202)
    expect(invokeMock).toHaveBeenCalledWith("telemetry_otlp_export", {
      endpoint: "https://collector.example/v1/traces",
      body: '{"resourceSpans":[]}',
      headers: { "content-type": "application/json", "x-tenant": "prod" },
      credential: { kind: "grafanaCloud", instanceId: "1234567" },
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    })
  })

  it("rejects secrets in renderer-supplied headers before IPC", async () => {
    const fetchImpl = createTauriOtlpFetch({ credential: { kind: "none" } })
    await expect(
      fetchImpl("https://collector.example/v1/traces", {
        method: "POST",
        headers: { Authorization: "Bearer leaked" },
        body: "{}",
      })
    ).rejects.toThrow(/sensitive header/i)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("passes only the PostHog public project token through the typed credential seam", async () => {
    invokeMock.mockResolvedValue({ status: 202, accepted: true })
    const fetchImpl = createTauriOtlpFetch({
      credential: { kind: "posthog", projectToken: "phc_project" },
    })
    await fetchImpl("https://us.i.posthog.com/i/v0/ai/otel", {
      method: "POST",
      body: '{"resourceSpans":[]}',
    })
    expect(invokeMock).toHaveBeenCalledWith(
      "telemetry_otlp_export",
      expect.objectContaining({
        credential: { kind: "posthog", projectToken: "phc_project" },
        headers: {},
      })
    )
  })

  it("maps rejected exports to an HTTP-shaped response", async () => {
    invokeMock.mockResolvedValue({ status: 503, accepted: false })
    const response = await createTauriOtlpFetch({ credential: { kind: "none" } })(
      "http://localhost:4318/v1/traces",
      { method: "POST", body: "{}" }
    )
    expect(response.ok).toBe(false)
    expect(response.status).toBe(503)
  })

  it("accepts URL inputs and rejects unsupported request shapes", async () => {
    invokeMock.mockResolvedValue({ status: 200, accepted: true })
    const fetchImpl = createTauriOtlpFetch({ credential: { kind: "none" } })
    await fetchImpl(new URL("http://localhost:4318/v1/traces"), { method: "POST", body: "{}" })
    await fetchImpl({ url: "http://localhost:4318/v1/traces" } as Request, {
      method: "POST",
      body: "{}",
    })
    await fetchImpl("http://localhost:4318/v1/traces")
    await expect(fetchImpl("http://localhost", { method: "GET" })).rejects.toThrow(/POST/)
    await expect(
      fetchImpl("http://localhost", { method: "POST", body: new Blob(["x"]) })
    ).rejects.toThrow(/string body/)
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchImpl("http://localhost", { method: "POST", signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})

it("posts Langfuse JSON through Rust without exposing its secret", async () => {
  invokeMock.mockResolvedValue({ status: 207, accepted: true })
  await postTauriTelemetryJson("https://cloud.langfuse.com/api/public/ingestion", '{"batch":[]}', {
    kind: "langfuse",
    publicKey: "pk-project",
  })
  expect(invokeMock).toHaveBeenCalledWith(
    "telemetry_otlp_export",
    expect.objectContaining({
      credential: { kind: "langfuse", publicKey: "pk-project" },
      body: '{"batch":[]}',
    })
  )
})

it("restarts the sidecar only when its telemetry environment changed", async () => {
  invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce(undefined)
  await configureTauriSidecarTelemetry({
    enabled: true,
    endpoint: "http://localhost:4318/v1/traces",
    headers: {},
    serviceName: "cognia-sidecar",
    environment: "development",
    credential: { kind: "none" },
  })
  expect(invokeMock).toHaveBeenNthCalledWith(1, "telemetry_configure_sidecar", expect.any(Object))
  expect(invokeMock).toHaveBeenNthCalledWith(2, "claude_restart_sidecar")

  invokeMock.mockReset()
  invokeMock.mockResolvedValue(false)
  await configureTauriSidecarTelemetry({
    enabled: false,
    endpoint: "http://localhost",
    headers: {},
    serviceName: "cognia-sidecar",
    environment: "",
    credential: { kind: "none" },
  })
  expect(invokeMock).toHaveBeenCalledTimes(1)
})
