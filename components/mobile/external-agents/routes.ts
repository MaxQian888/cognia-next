/**
 * Where the phone's external-agent screens live. One list, then a two-step
 * add flow (pick an agent, review and add), each its own route so the system
 * back gesture walks back one step at a time.
 */

export const EXTERNAL_AGENTS_ROUTE = "/me/external-agents"
export const ADD_EXTERNAL_AGENT_ROUTE = "/me/external-agents/new"
export const CONFIGURE_EXTERNAL_AGENT_ROUTE = "/me/external-agents/new/configure"

/** The review step for one preset (`"custom"` for a blank form). */
export function configureExternalAgentHref(presetId: string): string {
  return `${CONFIGURE_EXTERNAL_AGENT_ROUTE}?preset=${encodeURIComponent(presetId)}`
}
