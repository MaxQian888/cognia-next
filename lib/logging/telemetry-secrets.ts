import { invoke } from "@tauri-apps/api/core"
import { clearSecret, getSecret, setSecret } from "@/lib/keyring"
import { isTauri } from "@/lib/platform/detect"

export type TelemetrySecretKind = "grafanaCloudApiToken" | "langfuseSecretKey"

const SECRET_REFS = {
  grafanaCloudApiToken: { namespace: "telemetry", key: "grafana-cloud-api-token" },
  langfuseSecretKey: { namespace: "telemetry", key: "langfuse-secret-key" },
} as const

export interface LegacyTelemetrySecrets {
  grafanaCloudApiToken?: string
  langfuseSecretKey?: string
}

export interface LegacySecretExtraction {
  settings: Record<string, unknown>
  secrets: LegacyTelemetrySecrets
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Remove legacy plaintext credential fields while preserving all other settings. */
export function extractLegacyTelemetrySecrets(value: unknown): LegacySecretExtraction {
  const source = record(value)
  const settings = { ...source }
  const secrets: LegacyTelemetrySecrets = {}

  const langfuse = { ...record(source.langfuseConfig) }
  if (typeof langfuse.secretKey === "string" && langfuse.secretKey.length > 0) {
    secrets.langfuseSecretKey = langfuse.secretKey
    langfuse.secretKeyConfigured = true
  }
  delete langfuse.secretKey
  if (source.langfuseConfig !== undefined) settings.langfuseConfig = langfuse

  const otlp = { ...record(source.agentTraceOtlpConfig) }
  const grafana = { ...record(otlp.grafanaCloud) }
  if (typeof grafana.apiToken === "string" && grafana.apiToken.length > 0) {
    secrets.grafanaCloudApiToken = grafana.apiToken
    grafana.apiTokenConfigured = true
  }
  delete grafana.apiToken
  if (otlp.grafanaCloud !== undefined) otlp.grafanaCloud = grafana
  if (source.agentTraceOtlpConfig !== undefined) settings.agentTraceOtlpConfig = otlp

  return { settings, secrets }
}

export async function persistTelemetrySecret(
  kind: TelemetrySecretKind,
  value: string
): Promise<void> {
  if (!value) throw new Error("Telemetry secret must not be empty")
  if (isTauri()) {
    await invoke("telemetry_secret_set", { kind, value })
    return
  }
  await setSecret(SECRET_REFS[kind], value)
}

export async function clearTelemetrySecret(kind: TelemetrySecretKind): Promise<void> {
  if (isTauri()) {
    await invoke("telemetry_secret_clear", { kind })
    return
  }
  await clearSecret(SECRET_REFS[kind])
}

export async function hasTelemetrySecret(kind: TelemetrySecretKind): Promise<boolean> {
  if (isTauri()) {
    return await invoke<boolean>("telemetry_secret_has", { kind })
  }
  return (await getSecret(SECRET_REFS[kind])) !== null
}

/** Browser/mobile exporter helper. Tauri exporters must never read secrets back into JS. */
export async function getTelemetrySecretForWeb(kind: TelemetrySecretKind): Promise<string | null> {
  if (isTauri()) return null
  return getSecret(SECRET_REFS[kind])
}

export async function persistLegacyTelemetrySecrets(
  secrets: LegacyTelemetrySecrets
): Promise<void> {
  await Promise.all(
    (Object.entries(secrets) as Array<[TelemetrySecretKind, string | undefined]>)
      .filter((entry): entry is [TelemetrySecretKind, string] => Boolean(entry[1]))
      .map(([kind, value]) => persistTelemetrySecret(kind, value))
  )
}
