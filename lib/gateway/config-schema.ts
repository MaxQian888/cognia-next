import { z } from "zod"

import type { GatewayConfig } from "@/types/gateway"

const U32_MAX = 4_294_967_295
const u32 = z.number().int().min(0).max(U32_MAX)
const nonEmptyString = z.string().trim().min(1)

export const gatewayConfigSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(0).max(65_535),
    allowlist: z.array(nonEmptyString),
    rateLimitPerMin: u32.min(1),
    bindInterface: z.enum(["loopback", "lan"]),
    connectTimeoutSecs: u32.min(1),
    requestTimeoutSecs: u32,
    maxRetries: u32,
    retryStatusCodes: z.array(z.number().int().min(100).max(599)),
    retryBackoffBaseMs: u32,
    retryBackoffMaxMs: u32,
    maxRetryWaitMs: u32,
    respectRetryAfter: z.boolean(),
    gatewayLocalRoutingV2: z.boolean(),
    exposedModels: z.array(nonEmptyString),
    hideRawProviderModels: z.boolean(),
    cooldownFallbackSecs: u32,
    overloadCooldownSecs: u32,
    disableKeywords: z.array(nonEmptyString),
    maxConcurrentPerKey: u32,
    maxConcurrentPerUpstreamKey: u32,
    concurrencyWaitMs: u32,
    streamIdleTimeoutSecs: u32,
    strippedRequestFields: z.array(nonEmptyString),
    fieldStripAllow: z.array(nonEmptyString),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.retryBackoffBaseMs > config.retryBackoffMaxMs) {
      context.addIssue({
        code: "custom",
        path: ["retryBackoffBaseMs"],
        message: "retryBackoffBaseMs must not exceed retryBackoffMaxMs",
      })
    }
  })

export function parseGatewayConfig(value: unknown): GatewayConfig {
  return gatewayConfigSchema.parse(value) as GatewayConfig
}
