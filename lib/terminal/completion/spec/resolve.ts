/**
 * Pure spec resolution: walk the typed argument tokens to the deepest
 * matching subcommand node and produce the candidate set for the token
 * under the cursor. No I/O, fully unit-testable.
 */

import type { CliOption, CliSpec, CliSubcommand } from "./types"

export interface SpecCandidate {
  /** What acceptance inserts (canonical name). */
  name: string
  description?: string
  kind: "subcommand" | "option"
}

interface NodeLike {
  subcommands?: CliSubcommand[]
  options?: CliOption[]
}

/** Find a subcommand by canonical name or alias. */
function findSub(node: NodeLike, token: string): CliSubcommand | null {
  for (const sub of node.subcommands ?? []) {
    if (sub.name === token || (sub.aliases ?? []).includes(token)) return sub
  }
  return null
}

/** Does `token` match this option (canonical or alias, `--opt=value` form)? */
function matchesOption(opt: CliOption, token: string): boolean {
  const bare = token.split("=", 1)[0]
  return opt.name === bare || (opt.aliases ?? []).includes(bare)
}

/**
 * Resolve the candidates for `currentToken`, given the argument tokens
 * typed *before* it (head word excluded).
 *
 *   * Option tokens (`-x`/`--xy`) along the way are skipped; a matched
 *     `takesValue` option also swallows its following value token.
 *   * A `--`-prefixed current token completes options (deepest node's +
 *     the spec's globals); anything else completes subcommands.
 *   * Prefix filtering is case-insensitive; canonical casing is returned.
 */
export function resolveSpec(
  spec: CliSpec,
  priorTokens: string[],
  currentToken: string
): SpecCandidate[] {
  let node: NodeLike = spec
  const optionScopes: CliOption[][] = [spec.options ?? []]

  for (let i = 0; i < priorTokens.length; i++) {
    const token = priorTokens[i]
    if (token.startsWith("-")) {
      const known = [...(node.options ?? []), ...optionScopes.flat()].find((o) =>
        matchesOption(o, token)
      )
      if (known?.takesValue && !token.includes("=")) i++ // swallow the value
      continue
    }
    const sub = findSub(node, token)
    if (!sub) {
      // Unknown positional (a path, a branch name, …): the spec tree can't
      // descend further — no structural candidates from here on.
      return []
    }
    node = sub
    if (sub.options?.length) optionScopes.push(sub.options)
  }

  const prefixLower = currentToken.toLowerCase()
  const out: SpecCandidate[] = []
  const seen = new Set<string>()

  const pushAll = (candidates: SpecCandidate[]) => {
    for (const c of candidates) {
      const key = c.name.toLowerCase()
      if (seen.has(key)) continue
      if (prefixLower && !c.name.toLowerCase().startsWith(prefixLower)) continue
      if (c.name === currentToken) continue // nothing left to complete
      seen.add(key)
      out.push(c)
    }
  }

  if (currentToken.startsWith("-")) {
    const scoped = (node.options ?? []).map((o): SpecCandidate => ({
      name: o.name,
      description: o.description,
      kind: "option",
    }))
    const globals = optionScopes
      .flat()
      .map((o): SpecCandidate => ({ name: o.name, description: o.description, kind: "option" }))
    pushAll(scoped)
    pushAll(globals)
    return out
  }

  pushAll(
    (node.subcommands ?? []).map((s): SpecCandidate => ({
      name: s.name,
      description: s.description,
      kind: "subcommand",
    }))
  )
  return out
}
