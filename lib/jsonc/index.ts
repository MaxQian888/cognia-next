/**
 * Shared JSONC parsing.
 *
 * Several import surfaces read files that VS Code users author with
 * comments and trailing commas — color themes, snippets, language
 * configurations, icon themes, grammars, MCP server configs, code-server's
 * `settings.json` and `argv.json`. `jsonc-parser` is the single sanctioned
 * parser for all of them: unlike the hand-rolled comment strippers this
 * module replaced, it never rewrites `,}` / `,]` sequences inside string
 * values and correctly rejects single-quoted strings.
 *
 * jsonc-parser recovers partial values from malformed input instead of
 * throwing, so both wrappers check the `errors` array to preserve the
 * reject-on-error contract `JSON.parse` gave their callers.
 */
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"

/**
 * Parse JSONC text (comments + trailing commas allowed), throwing a
 * `SyntaxError` on any syntax error — the same contract `JSON.parse` gave
 * the call sites that add their own context in a try/catch. The message
 * names the first problem and where it occurred (e.g. `ValueExpected at
 * offset 0`).
 */
export function parseJsonc<T = unknown>(text: string): T {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true }) as T
  if (errors.length > 0) {
    const first = errors[0]
    throw new SyntaxError(`${printParseErrorCode(first.error)} at offset ${first.offset}`)
  }
  return value
}

/**
 * `parseJsonc` for callers that degrade instead of rejecting: returns
 * `undefined` on any syntax error rather than throwing. Never throws.
 */
export function tryParseJsonc<T = unknown>(text: string): T | undefined {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true }) as T | undefined
  return errors.length > 0 ? undefined : value
}
