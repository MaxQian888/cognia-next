/**
 * Reading an agent's session config options (ADR-0217).
 *
 * ACP-family agents publish their model and thinking choices as
 * `configOptions`; adapters and hosts locate them the same way, so the lookup
 * lives here once.
 */

import type { AcpConfigOption, AcpConfigOptionValue } from "@cognia/agent-contracts/external-agent"

/** The one select option an agent uses for models, if it declares one. */
export function findModelConfigOption(
  configOptions: readonly AcpConfigOption[] | undefined
): Extract<AcpConfigOption, { type: "select" }> | undefined {
  return configOptions?.find(
    (option): option is Extract<AcpConfigOption, { type: "select" }> =>
      option.category === "model" && option.type === "select"
  )
}

/** Flatten `AcpConfigOptionValue[] | AcpConfigOptionGroup[]` into plain values. */
export function flattenValues(
  options: Extract<AcpConfigOption, { type: "select" }>["options"]
): AcpConfigOptionValue[] {
  return options.flatMap((entry) => ("group" in entry ? entry.options : [entry]))
}
