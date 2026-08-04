import type { CanonicalContentPart } from "@cognia/agent-config-types/agent-execution"

import { validateA2UISurface } from "../a2ui/surface"
import { sanitizeTerminalText } from "./terminal-block"

export type ContentPartValidation =
  { ok: true; part: CanonicalContentPart } | { ok: false; reason: string }

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const SAFE_URI_SCHEMES = new Set(["file:", "artifact:", "session:", "https:"])

export function isSafeContentUri(uri: string): boolean {
  if (uri.startsWith("/") || WINDOWS_ABSOLUTE.test(uri)) return true
  try {
    return SAFE_URI_SCHEMES.has(new URL(uri).protocol)
  } catch {
    return false
  }
}

export function validateContentPart(part: CanonicalContentPart): ContentPartValidation {
  switch (part.type) {
    case "file":
      if (!isSafeContentUri(part.uri)) {
        return { ok: false, reason: `Unsafe file URI scheme for ${part.name}` }
      }
      return {
        ok: true,
        part: {
          ...part,
          name: sanitizeTerminalText(part.name),
          ...(part.preview
            ? { preview: sanitizeTerminalText(part.preview).slice(0, 16 * 1024) }
            : {}),
        },
      }
    case "sources":
      return {
        ok: true,
        part: {
          ...part,
          sources: part.sources.map((source) => ({
            ...source,
            ...(source.title ? { title: sanitizeTerminalText(source.title) } : {}),
            ...(source.origin ? { origin: sanitizeTerminalText(source.origin) } : {}),
            ...(source.snippet ? { snippet: sanitizeTerminalText(source.snippet) } : {}),
            ...(source.url && isSafeContentUri(source.url)
              ? { url: source.url }
              : { url: undefined }),
          })),
        },
      }
    case "a2ui": {
      const validated = validateA2UISurface(part.surfaceId, part.payload)
      if (!validated.ok) return validated
      return {
        ok: true,
        part: {
          ...part,
          payload: {
            rootId: validated.surface.rootId,
            components: validated.surface.components,
            dataModel: validated.surface.dataModel,
          },
        },
      }
    }
    case "artifact-ref":
    case "canvas-ref":
      return { ok: true, part }
    case "custom": {
      try {
        if (Buffer.byteLength(JSON.stringify(part.data ?? null), "utf8") > 1024 * 1024) {
          return { ok: false, reason: "Custom content payload exceeds 1 MiB" }
        }
      } catch {
        return { ok: false, reason: "Custom content payload is not serializable" }
      }
      return { ok: true, part: { ...part, summary: sanitizeTerminalText(part.summary) } }
    }
  }
}
