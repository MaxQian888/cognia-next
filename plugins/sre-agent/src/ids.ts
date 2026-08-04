export const PLUGIN_ID = "sre-agent" as const

export const SRE_SUBAGENT_ID = "incident-diagnostician" as const

export function sreSubagentRuntimeId(localId = SRE_SUBAGENT_ID): string {
  return `${PLUGIN_ID}:${localId}`
}
