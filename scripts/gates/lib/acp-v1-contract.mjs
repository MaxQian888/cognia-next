import { readFileSync } from "node:fs"

const contractUrl = new URL("../../../protocol/acp/v1/contract.json", import.meta.url)

export const ACP_V1_CONTRACT = Object.freeze(JSON.parse(readFileSync(contractUrl, "utf8")))

const COVERAGE_KEYS = ["clientToAgent", "agentToClient", "protocol", "updates"]

function valuesForCompatibility(key) {
  if (key === "clientToAgent") return ACP_V1_CONTRACT.compatibility.agentMethods
  if (key === "agentToClient") return ACP_V1_CONTRACT.compatibility.clientMethods
  if (key === "updates") return ACP_V1_CONTRACT.compatibility.updates
  return []
}

function valuesForFeatureGated(key) {
  return ACP_V1_CONTRACT.featureGated[key] ?? []
}

export function validateAcpV1Coverage(coverage) {
  const missing = {}
  const unknown = {}
  const unstableOrLegacy = {}

  for (const key of COVERAGE_KEYS) {
    const actual = new Set(coverage[key] ?? [])
    const stable = new Set(ACP_V1_CONTRACT.stable[key])
    const nonStable = new Set([...valuesForCompatibility(key), ...valuesForFeatureGated(key)])

    missing[key] = [...stable].filter((value) => !actual.has(value))
    unstableOrLegacy[key] = [...actual].filter((value) => nonStable.has(value))
    unknown[key] = [...actual].filter((value) => !stable.has(value) && !nonStable.has(value))
  }

  return {
    complete: COVERAGE_KEYS.every((key) => missing[key].length === 0),
    missing,
    unknown,
    unstableOrLegacy,
  }
}
