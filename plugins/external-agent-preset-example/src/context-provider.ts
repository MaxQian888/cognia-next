/**
 * Lazy-factory entry for the `contextProviders` manifest field (Thread C1).
 * The context-providers bridge dynamic-imports this module on enable, calls the
 * factory, and registers the returned provider under
 * `cognia-external-agent-preset-example:env-banner`. Its `provide()` output is
 * appended to the system prompt of the plugin's agent runs.
 */

import type { PluginContextProvider, PluginContextProviderFactoryContext } from "@cognia/plugin-sdk"
export function createEnvBannerProvider(
  ctx: PluginContextProviderFactoryContext
): PluginContextProvider {
  return {
    id: ctx.providerId,
    name: "Environment Banner",
    provide: ({ prompt }) =>
      prompt.trim().length > 0
        ? "Context note: this run may delegate to an external CLI agent. Prefer surgical, well-scoped edits."
        : null,
  }
}
