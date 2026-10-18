import { restBaseOf } from "@/lib/ai/operations/handlers/http"
import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"

/** Keep a subscription account on the declared billing endpoint, including protocol normalization. */
export function resolveSubscriptionEndpoint(
  definition: SubscriptionProviderDefinition,
  override?: string
): string {
  const normalize = (value: string) => {
    const url = new URL(value)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (definition.billingMode === "subscription" && url.protocol !== "https:")
    )
      throw new Error("Invalid subscription endpoint")
    return restBaseOf({
      protocol: definition.protocol ?? "openai",
      baseURL: url.toString().replace(/\/+$/, ""),
    })!
  }
  const baseURL = normalize(override?.trim() || definition.baseUrl || "")
  if (
    definition.billingMode === "subscription" &&
    baseURL !== normalize(definition.baseUrl ?? "")
  ) {
    throw new Error("Subscription endpoint must match the provider declaration")
  }
  return baseURL
}

/** A subscription preset may not replace the host-owned account authentication. */
export function subscriptionRequestHeaders(
  definition: SubscriptionProviderDefinition,
  headers: Record<string, string> = {}
): Record<string, string> {
  const entries = Object.entries(headers).filter(
    ([name]) => !name.toLowerCase().startsWith("x-cognia-")
  )
  if (
    definition.billingMode === "subscription" &&
    entries.some(([name]) => /^(authorization|x-api-key|api-key|cookie|host)$/i.test(name))
  )
    throw new Error("Subscription authentication cannot be overridden by a preset")
  return Object.fromEntries(entries)
}
