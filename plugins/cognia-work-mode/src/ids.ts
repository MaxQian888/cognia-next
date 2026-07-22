export const PLUGIN_ID = "cognia-work-mode"

export function workSkillId(localId: string): string {
  return `${PLUGIN_ID}:${localId}`
}

export function workSubagentId(localId: string): string {
  return `${PLUGIN_ID}:${localId}`
}
