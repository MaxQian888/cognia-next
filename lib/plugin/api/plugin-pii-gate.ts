/**
 * PII red-line for plugin-initiated model calls.
 *
 * The app-wide rule (Twin/Goal/Connector auto-mode, enforced via
 * `lib/twin/ingest/redact.ts:hasNoLeakingPii` and the
 * `lib/connectors/ai-loop/safe-send-prompt.ts` wrapper) is: raw
 * user-supplied text MUST pass the PII gate before it leaves the device.
 * `ctx.ai.chat/embed` and `ctx.vector.embed/embedBatch` are plugin-driven
 * model sends with no human review step, so the same gate applies here.
 */

import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@/lib/twin/ingest/redact"

export class PluginPiiError extends Error {
  public readonly pluginId: string
  public readonly site: string

  constructor(pluginId: string, site: string) {
    super(
      `[${site}] blocked for plugin "${pluginId}": content failed the PII redaction gate ` +
        `(hasNoLeakingPii). Redact emails/ids/keys before sending to a model.`
    )
    this.name = "PluginPiiError"
    this.pluginId = pluginId
    this.site = site
  }
}

/**
 * Throws `PluginPiiError` when any of `texts` trips the PII detector.
 * Non-string / empty entries are ignored.
 */
export function assertNoLeakingPii(
  pluginId: string,
  site: string,
  texts: ReadonlyArray<string | undefined | null>
): void {
  for (const text of texts) {
    if (typeof text === "string" && text.length > 0 && !hasNoLeakingPii(text)) {
      throw new PluginPiiError(pluginId, site)
    }
  }
}

/**
 * Deep variant for structured values (e.g. vector document metadata):
 * throws when any nested string trips the PII detector.
 */
export function assertNoLeakingPiiDeep(
  pluginId: string,
  site: string,
  values: ReadonlyArray<unknown>
): void {
  for (const value of values) {
    if (value !== undefined && value !== null && !hasNoLeakingPiiDeep(value)) {
      throw new PluginPiiError(pluginId, site)
    }
  }
}
