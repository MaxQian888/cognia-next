/**
 * Build the `/model` switcher's option list from the resolved config: the active
 * model plus every per-provider model, de-duplicated and order-preserved. Pure.
 */
import type { ResolvedConfig } from "../../config/schema"

export function collectModelOptions(config: ResolvedConfig): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (m: string | undefined) => {
    if (m && m.length > 0 && !seen.has(m)) {
      seen.add(m)
      out.push(m)
    }
  }
  add(config.model)
  for (const provider of Object.values(config.providers)) add(provider.model)
  return out
}
