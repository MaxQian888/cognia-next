/**
 * Build the `/model` switcher's option list for the ACTIVE provider, reusing the
 * desktop's curated model catalog (`catalogModelIds` over the shared `PROVIDERS`
 * registry) so the CLI and app agree and a provider switch yields the right
 * list. Order: the active model, the active provider's configured model, the
 * active provider's catalog, then any other per-provider configured models —
 * de-duplicated and order-preserved. Pure.
 */
import { catalogModelIds } from "@/lib/ai/model-options"

import type { ResolvedConfig } from "../../config/schema"

export function collectModelOptions(config: ResolvedConfig): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (m: string | undefined) => {
    if (m && !seen.has(m)) {
      seen.add(m)
      out.push(m)
    }
  }
  add(config.model)
  // The active provider leads: its configured model + curated catalog. This is
  // what makes a `/provider` switch surface the correct model list.
  add(config.providers[config.provider]?.model)
  for (const id of catalogModelIds(config.provider)) add(id)
  // Other providers' explicitly-configured models remain reachable.
  for (const provider of Object.values(config.providers)) add(provider.model)
  return out
}
