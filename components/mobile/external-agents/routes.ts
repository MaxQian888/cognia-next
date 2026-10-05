/**
 * Where the phone's external-agent screens live. One list, a two-step add flow
 * (pick an agent, review and add) and one detail screen per Host
 * configuration, each its own route so the system back gesture walks back one
 * step at a time.
 */

export const EXTERNAL_AGENTS_ROUTE = "/me/external-agents"
export const ADD_EXTERNAL_AGENT_ROUTE = "/me/external-agents/new"
export const CONFIGURE_EXTERNAL_AGENT_ROUTE = "/me/external-agents/new/configure"
export const EXTERNAL_AGENT_DETAIL_ROUTE = "/me/external-agents/detail"

/** The review step for one preset (`"custom"` for a blank form). */
export function configureExternalAgentHref(presetId: string): string {
  return `${CONFIGURE_EXTERNAL_AGENT_ROUTE}?preset=${encodeURIComponent(presetId)}`
}

/**
 * The detail screen for one Host configuration. The id is a query parameter
 * for the same reason the preset is: a static export cannot pre-render a page
 * per configuration the Host will ever mint.
 */
export function externalAgentDetailHref(configId: string): string {
  return `${EXTERNAL_AGENT_DETAIL_ROUTE}?id=${encodeURIComponent(configId)}`
}
