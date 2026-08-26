import type { AgentTraceBatchV1 } from "@cognia/agent-trace"

import { transport } from "@/lib/tauri/transport-instance"

export interface LangfuseCredentialsInput {
  enabled: boolean
  baseUrl: string
  publicKey: string
  /** Omit to retain the write-only secret already stored by this Host. */
  secretKey?: string
  environment: string
  captureModelContent: boolean
  captureToolContent: boolean
}

export interface LangfuseCredentialsStatus {
  configured: boolean
  enabled: boolean
  baseUrl: string | null
  publicKey: string | null
  environment: string | null
  captureModelContent: boolean
  captureToolContent: boolean
}

export interface LangfuseConnectionStatus {
  connected: boolean
  status: number
}

export interface LangfuseTraceIngestResult {
  acceptedSpans: number
  duplicateSpans: number
  status: number
}

/** Store account-scoped credentials without ever reading the secret back. */
export function setLangfuseCredentials(input: LangfuseCredentialsInput): Promise<void> {
  return transport.call<void>("langfuse_credentials_set", input)
}

export function getLangfuseCredentialsStatus(): Promise<LangfuseCredentialsStatus> {
  return transport.call<LangfuseCredentialsStatus>("langfuse_credentials_status", {})
}

export function clearLangfuseCredentials(): Promise<void> {
  return transport.call<void>("langfuse_credentials_clear", {})
}

export function testLangfuseConnection(): Promise<LangfuseConnectionStatus> {
  return transport.call<LangfuseConnectionStatus>("langfuse_connection_test", {})
}

/** The Host fixes the destination path and headers after validating this batch. */
export function ingestLangfuseTraceBatch(
  batch: AgentTraceBatchV1
): Promise<LangfuseTraceIngestResult> {
  return transport.call<LangfuseTraceIngestResult>("langfuse_trace_ingest", { batch })
}
