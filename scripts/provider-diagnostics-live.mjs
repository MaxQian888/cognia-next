#!/usr/bin/env node

import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { createFeatureCallHandler } from "../sidecar/dispatch/feature-call.mjs"

const PROMPT = "Reply with exactly: diagnostic-ok"

function requiredEnv(names, env) {
  const missing = names.filter((name) => !env[name])
  return missing.length === 0 ? null : `Missing ${missing.join(", ")}`
}

function redactError(error, env) {
  let message = error instanceof Error ? error.message : String(error)
  for (const [name, value] of Object.entries(env)) {
    if (!/(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name) || typeof value !== "string" || !value) {
      continue
    }
    message = message.replaceAll(value, "[REDACTED]")
  }
  return message
}

async function runLanguageFamily(family, config, env) {
  const missing = requiredEnv(config.required, env)
  if (missing) return { family, status: "unverified", reason: missing }
  const startedAt = Date.now()
  const requestId = `live-${family}-${startedAt}`
  const events = []
  const handler = createFeatureCallHandler({ emit: (event) => events.push(event) })
  await handler.call({
    requestId,
    operation: "language-stream",
    providerId: config.providerId,
    model: env[config.model],
    credentials: config.credentials(env),
    options: {
      prompt: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
      maxOutputTokens: 16,
      temperature: 0,
    },
  })
  const failure = events.find((event) => event.type === "feature_call_error")
  const chunks = events.filter((event) => event.type === "feature_call_stream")
  return failure
    ? {
        family,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: redactError(failure.error, env),
      }
    : {
        family,
        status: chunks.length > 0 ? "verified" : "failed",
        durationMs: Date.now() - startedAt,
        chunkCount: chunks.length,
      }
}

async function runBalanceClass(family, config, env, fetchImpl) {
  const missing = requiredEnv(config.required, env)
  if (missing) return { family, status: "unverified", reason: missing }
  const startedAt = Date.now()
  try {
    const response = await fetchImpl(env[config.url], {
      headers: { authorization: `Bearer ${env[config.token]}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.text()
    JSON.parse(body)
    return {
      family,
      status: response.ok ? "verified" : "failed",
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      family,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: redactError(error, env),
    }
  }
}

export async function runLiveProviderDiagnostics({ env = process.env, fetchImpl = fetch } = {}) {
  const languageFamilies = [
    {
      family: "openai-responses",
      required: ["OPENAI_API_KEY", "OPENAI_MODEL"],
      model: "OPENAI_MODEL",
      providerId: "openai",
      credentials: (values) => ({
        protocol: "openai",
        apiFlavor: "responses",
        apiKey: values.OPENAI_API_KEY,
        baseURL: values.OPENAI_BASE_URL,
      }),
    },
    {
      family: "openai-compatible-chat",
      required: ["COMPAT_API_KEY", "COMPAT_BASE_URL", "COMPAT_MODEL"],
      model: "COMPAT_MODEL",
      providerId: "custom",
      credentials: (values) => ({
        protocol: "openai",
        apiFlavor: "chat-completions",
        apiKey: values.COMPAT_API_KEY,
        baseURL: values.COMPAT_BASE_URL,
      }),
    },
    {
      family: "anthropic",
      required: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
      model: "ANTHROPIC_MODEL",
      providerId: "anthropic",
      credentials: (values) => ({
        protocol: "anthropic",
        apiKey: values.ANTHROPIC_API_KEY,
        baseURL: values.ANTHROPIC_BASE_URL,
      }),
    },
    {
      family: "gemini",
      required: ["GEMINI_API_KEY", "GEMINI_MODEL"],
      model: "GEMINI_MODEL",
      providerId: "google",
      credentials: (values) => ({
        protocol: "google",
        apiKey: values.GEMINI_API_KEY,
        baseURL: values.GEMINI_BASE_URL,
      }),
    },
    {
      family: "bedrock",
      required: ["AWS_REGION", "BEDROCK_MODEL"],
      model: "BEDROCK_MODEL",
      providerId: "bedrock",
      credentials: (values) => ({
        protocol: "bedrock",
        bedrockAuthMode: values.AWS_ACCESS_KEY_ID ? "access-key" : "default-chain",
        region: values.AWS_REGION,
        accessKeyId: values.AWS_ACCESS_KEY_ID,
        secretAccessKey: values.AWS_SECRET_ACCESS_KEY,
        sessionToken: values.AWS_SESSION_TOKEN,
        profile: values.AWS_PROFILE,
      }),
    },
    {
      family: "local-openai-ollama",
      required: ["LOCAL_OPENAI_BASE_URL", "LOCAL_OPENAI_MODEL"],
      model: "LOCAL_OPENAI_MODEL",
      providerId: "ollama",
      credentials: (values) => ({
        protocol: "openai",
        apiFlavor: "chat-completions",
        apiKey: values.LOCAL_OPENAI_API_KEY ?? "local",
        baseURL: values.LOCAL_OPENAI_BASE_URL,
      }),
    },
  ]
  const balanceFamilies = [
    {
      family: "balance-absolute-bearer",
      required: ["BALANCE_ABSOLUTE_URL", "BALANCE_ABSOLUTE_TOKEN"],
      url: "BALANCE_ABSOLUTE_URL",
      token: "BALANCE_ABSOLUTE_TOKEN",
    },
    {
      family: "balance-credits-minus-usage",
      required: ["BALANCE_CREDITS_URL", "BALANCE_CREDITS_TOKEN"],
      url: "BALANCE_CREDITS_URL",
      token: "BALANCE_CREDITS_TOKEN",
    },
    {
      family: "balance-quota-window-signed-cloud",
      required: ["BALANCE_QUOTA_URL", "BALANCE_QUOTA_TOKEN"],
      url: "BALANCE_QUOTA_URL",
      token: "BALANCE_QUOTA_TOKEN",
    },
  ]
  const evidence = []
  for (const config of languageFamilies) {
    evidence.push(await runLanguageFamily(config.family, config, env))
  }
  for (const config of balanceFamilies) {
    evidence.push(await runBalanceClass(config.family, config, env, fetchImpl))
  }
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    promptVersion: "provider-diagnostics-live-v1",
    evidence,
    complete: evidence.every((item) => item.status === "verified"),
  }
}

async function main() {
  const report = await runLiveProviderDiagnostics()
  const outputIndex = process.argv.indexOf("--output")
  if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
    await writeFile(process.argv[outputIndex + 1], `${JSON.stringify(report, null, 2)}\n`, "utf8")
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.complete) process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
