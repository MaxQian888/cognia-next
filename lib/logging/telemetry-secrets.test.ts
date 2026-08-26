/** @jest-environment jsdom */

jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/keyring", () => ({
  setSecret: jest.fn(),
  getSecret: jest.fn(),
  clearSecret: jest.fn(),
}))

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform/detect"
import { clearSecret, getSecret, setSecret } from "@/lib/keyring"
import {
  clearTelemetrySecret,
  extractLegacyTelemetrySecrets,
  hasTelemetrySecret,
  persistLegacyTelemetrySecrets,
  persistTelemetrySecret,
} from "./telemetry-secrets"

const invokeMock = invoke as jest.MockedFunction<typeof invoke>
const isTauriMock = isTauri as jest.MockedFunction<typeof isTauri>

describe("telemetry secret persistence", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReturnValue(true)
    jest.mocked(setSecret).mockReset()
    jest.mocked(getSecret).mockReset()
    jest.mocked(clearSecret).mockReset()
  })

  it("removes legacy plaintext values and replaces them with references", () => {
    const result = extractLegacyTelemetrySecrets({
      langfuseConfig: { publicKey: "pk", secretKey: "sk-live-secret" },
      agentTraceOtlpConfig: {
        grafanaCloud: { instanceId: "123", apiToken: "glc_secret" },
      },
    })

    expect(result.secrets).toEqual({
      langfuseSecretKey: "sk-live-secret",
      grafanaCloudApiToken: "glc_secret",
    })
    expect(result.settings).toMatchObject({
      langfuseConfig: { publicKey: "pk", secretKeyConfigured: true },
      agentTraceOtlpConfig: {
        grafanaCloud: { instanceId: "123", apiTokenConfigured: true },
      },
    })
    expect(JSON.stringify(result.settings)).not.toContain("sk-live-secret")
    expect(JSON.stringify(result.settings)).not.toContain("glc_secret")
  })

  it("uses the write-only telemetry command in Tauri", async () => {
    invokeMock.mockResolvedValue(undefined)
    await persistTelemetrySecret("grafanaCloudApiToken", "glc_secret")
    expect(invokeMock).toHaveBeenCalledWith("telemetry_secret_set", {
      kind: "grafanaCloudApiToken",
      value: "glc_secret",
    })
  })

  it("does not invent nested settings or migrate empty legacy values", () => {
    expect(extractLegacyTelemetrySecrets(null)).toEqual({ settings: {}, secrets: {} })
    const result = extractLegacyTelemetrySecrets({
      langfuseConfig: { secretKey: "" },
      agentTraceOtlpConfig: { grafanaCloud: { apiToken: "" } },
    })
    expect(result.secrets).toEqual({})
    expect(JSON.stringify(result.settings)).not.toMatch(/secretKey|apiToken"/)
  })

  it("supports Tauri clear/has while keeping readback unavailable", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true)
    await clearTelemetrySecret("langfuseSecretKey")
    await expect(hasTelemetrySecret("langfuseSecretKey")).resolves.toBe(true)
    expect(invokeMock).toHaveBeenNthCalledWith(1, "telemetry_secret_clear", {
      kind: "langfuseSecretKey",
    })
  })

  it("rejects empty secrets before persistence", async () => {
    await expect(persistTelemetrySecret("langfuseSecretKey", "")).rejects.toThrow(/empty/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("uses the keyring adapter outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    jest.mocked(getSecret).mockResolvedValue("sk-browser")
    await persistTelemetrySecret("langfuseSecretKey", "sk-browser")
    await clearTelemetrySecret("langfuseSecretKey")
    await expect(hasTelemetrySecret("langfuseSecretKey")).resolves.toBe(true)
    expect(setSecret).toHaveBeenCalledWith(
      { namespace: "telemetry", key: "langfuse-secret-key" },
      "sk-browser"
    )
    expect(clearSecret).toHaveBeenCalled()
  })

  it("rejects Grafana credentials outside the secure desktop Host", async () => {
    isTauriMock.mockReturnValue(false)

    await expect(
      persistTelemetrySecret("grafanaCloudApiToken", "glc_browser_secret")
    ).rejects.toThrow(/secure desktop Host/)
    expect(setSecret).not.toHaveBeenCalled()
  })

  it("persists every non-empty migrated secret", async () => {
    invokeMock.mockResolvedValue(undefined)
    await persistLegacyTelemetrySecrets({
      grafanaCloudApiToken: "grafana",
      langfuseSecretKey: undefined,
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
