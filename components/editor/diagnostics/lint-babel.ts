/**
 * TypeScript / JavaScript / JSX / TSX **syntax** diagnostics via `@babel/parser`.
 *
 * This is a syntax check, not a type check — the offline mobile editor has no
 * type information. `@babel/parser` is lazy-loaded (only on the first TS/JS lint)
 * to keep the mobile bundle lean; `errorRecovery: true` collects every parse
 * error instead of throwing on the first, and any hard failure is swallowed so
 * checking can never break editing.
 */

import { lineColToOffset } from "./offset"
import type { EditorDiagnostic } from "./types"

const MAX_DIAGNOSTICS = 100
const TRAILING_LOC_RE = /\s*\(\d+:\d+\)\s*$/

interface BabelLoc {
  line?: number
  column?: number
  index?: number
}
interface BabelError {
  loc?: BabelLoc
  message?: string
  reasonCode?: string
}

export async function lintBabel(text: string): Promise<EditorDiagnostic[]> {
  if (text.trim() === "") return []
  let errors: BabelError[] = []
  try {
    const { parse } = await import("@babel/parser")
    const ast = parse(text, {
      sourceType: "module",
      errorRecovery: true,
      // Both plugins cover ts/tsx/js/jsx — the closed `EditorLanguage` union
      // collapses all four onto "typescript".
      plugins: ["typescript", "jsx"],
    })
    errors = ((ast as unknown as { errors?: BabelError[] }).errors ?? []) as BabelError[]
  } catch (err) {
    // Some fatal errors still throw even with errorRecovery; surface that one.
    const single = err as BabelError
    if (single && typeof single === "object" && single.loc) {
      errors = [single]
    } else {
      return []
    }
  }

  return errors.slice(0, MAX_DIAGNOSTICS).map((e) => {
    const from = locate(text, e.loc)
    return {
      from,
      to: Math.min(from + 1, text.length),
      severity: "error" as const,
      message: cleanMessage(e),
      source: "babel",
    }
  })
}

export function locate(text: string, loc: BabelLoc | undefined): number {
  if (loc && typeof loc.index === "number" && Number.isFinite(loc.index)) {
    return Math.min(Math.max(loc.index, 0), text.length)
  }
  if (loc && typeof loc.line === "number") {
    return lineColToOffset(text, loc.line, loc.column ?? 0)
  }
  return 0
}

export function cleanMessage(e: BabelError): string {
  const raw = e.message ?? e.reasonCode ?? "Syntax error"
  return raw.replace(TRAILING_LOC_RE, "")
}
