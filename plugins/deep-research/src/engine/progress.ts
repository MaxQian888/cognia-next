/**
 * The engine's one door to user-facing text.
 *
 * The engine stays free of any host or i18n dependency: it names a message by
 * key and the injected {@link EngineDeps.text} renders it in the user's
 * language. Without a renderer (an engine unit test) the key itself is the
 * text, which is never what a user sees — `buildEngineDeps` always binds one.
 */
import type { EngineDeps, EngineMessageKey } from "../types"

export function engineText(
  deps: Pick<EngineDeps, "text">,
  key: EngineMessageKey,
  params?: Record<string, string | number>
): string {
  return deps.text ? deps.text(key, params) : key
}

/** Report progress with a localized message. */
export function reportEngineProgress(
  deps: Pick<EngineDeps, "text" | "reportProgress">,
  fraction: number,
  key: EngineMessageKey,
  params?: Record<string, string | number>
): void {
  deps.reportProgress?.(fraction, engineText(deps, key, params))
}
