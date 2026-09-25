"use client"

/**
 * Turn a plugin-lifecycle failure into a sentence the user can read.
 *
 * The manager throws English `Error`s (`lib/plugin/core/manager.ts`), and every
 * surface that toasted one printed `error.message` verbatim: a zh-CN user saw
 * `Cannot stop plugin "a": required by "b"` with no translation and no hint of
 * what to do. The messages have stable shapes, so they are classified here and
 * rendered from `plugins.errors.codes.*`. Anything unrecognised falls through
 * to the raw message rather than a generic "something went wrong", because the
 * raw text is still the most specific thing we have.
 *
 * The classifier matches the manager's CURRENT wording. A reworded manager
 * error degrades to the raw message, never to a wrong translation.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

export type PluginErrorCode =
  | "dependencyInUse"
  | "dependencyMissing"
  | "pythonDisabled"
  | "intentDisabled"
  | "dirtyRuntime"
  | "frontendTrust"
  | "notFound"
  | "managerNotReady"
  | "incompatible"
  | "signature"
  | "invalidManifest"
  | "uninstallMirrored"

export interface ClassifiedPluginError {
  code: PluginErrorCode | null
  /** The original message, always kept for "details" surfaces and logs. */
  message: string
  /** Interpolation values for the localized message. */
  values: Record<string, string>
}

function unquoteList(raw: string): string {
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .join(", ")
}

const PATTERNS: ReadonlyArray<{
  code: PluginErrorCode
  test: RegExp
  values?: (match: RegExpMatchArray) => Record<string, string>
}> = [
  {
    code: "dependencyInUse",
    test: /^Cannot stop plugin "[^"]+": required by (.+)$/,
    values: (m) => ({ dependents: unquoteList(m[1] ?? "") }),
  },
  {
    code: "dependencyMissing",
    test: /^Cannot enable plugin "[^"]+": unmet required dependencies — (.+)$/,
    values: (m) => ({ dependencies: m[1] ?? "" }),
  },
  { code: "pythonDisabled", test: /the Python runtime is disabled in this profile/ },
  { code: "intentDisabled", test: /^Plugin "[^"]+" is explicitly disabled$/ },
  {
    code: "dirtyRuntime",
    test: /has unconfirmed runtime resources|has unresolved runtime resources/,
  },
  { code: "frontendTrust", test: /runs un-sandboxed JavaScript in the renderer/ },
  { code: "notFound", test: /^Plugin not found: / },
  { code: "managerNotReady", test: /^Plugin manager not initialized/ },
  {
    code: "incompatible",
    test: /^Incompatible plugin|^The plugin is incompatible with this host/,
  },
  { code: "signature", test: /^Signature verification failed/ },
  { code: "invalidManifest", test: /^Invalid plugin manifest/ },
]

/** Error classes this layer raises itself carry their code directly. */
function ownCode(error: unknown): PluginErrorCode | null {
  if (error && typeof error === "object" && "pluginErrorCode" in error) {
    const code = (error as { pluginErrorCode?: unknown }).pluginErrorCode
    if (typeof code === "string") return code as PluginErrorCode
  }
  return null
}

export function classifyPluginError(error: unknown): ClassifiedPluginError {
  const message = error instanceof Error ? error.message : String(error ?? "")
  const own = ownCode(error)
  if (own) return { code: own, message, values: {} }
  for (const pattern of PATTERNS) {
    const match = message.match(pattern.test)
    if (match) return { code: pattern.code, message, values: pattern.values?.(match) ?? {} }
  }
  return { code: null, message, values: {} }
}

/**
 * `(error) => localized sentence`. Accepts an `Error`, a message string (what
 * `setPluginEnabledForHost` returns), or anything else a catch block can hold.
 */
export function usePluginErrorMessage(): (error: unknown) => string {
  const t = useTranslations("plugins.errors.codes")
  return useCallback(
    (error: unknown) => {
      const classified = classifyPluginError(error)
      if (classified.code === null) return classified.message
      return t(classified.code, classified.values)
    },
    [t]
  )
}
