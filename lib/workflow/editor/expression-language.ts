/**
 * A tiny CodeMirror language for the workflow expression mini-syntax.
 *
 * What we highlight:
 *   • The opening `{{` and closing `}}` mustaches.
 *   • Inside the mustache: `$node` / `$trigger` / `$static` / `$params`
 *     keywords, single-quoted strings (typical for `$node['id']`), and the
 *     `out` accessor.
 *
 * Outside the mustaches the buffer is treated as plain text.
 *
 * We avoid building a full lezer grammar — the syntax is too small to justify
 * the toolchain. Instead we use CodeMirror 6's StreamLanguage which lets us
 * write a hand-rolled state machine.
 */

import { StreamLanguage, type StreamParser } from "@codemirror/language"

interface ExprState {
  /** True when the cursor is between {{ and }}. */
  inMustache: boolean
}

export const expressionStreamParser: StreamParser<ExprState> = {
  name: "workflowExpression",
  startState: () => ({ inMustache: false }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (!state.inMustache) {
      // Outside a mustache: scan to next `{{`.
      if (stream.match("{{")) {
        state.inMustache = true
        return "punctuation.special"
      }
      // Eat one char at a time so newlines + whitespace flow normally.
      stream.next()
      return null
    }
    // Inside a mustache.
    if (stream.match("}}")) {
      state.inMustache = false
      return "punctuation.special"
    }
    if (stream.eatSpace()) return null
    // Single-quoted strings (typical for $node['id']).
    if (stream.match(/'[^']*'/)) return "string"
    // Double-quoted strings.
    if (stream.match(/"[^"]*"/)) return "string"
    // Numeric literal.
    if (stream.match(/-?\d+(\.\d+)?/)) return "number"
    // Keyword tokens.
    if (stream.match(/\$node\b/)) return "keyword"
    if (stream.match(/\$trigger\b/)) return "keyword"
    if (stream.match(/\$static\b/)) return "keyword"
    if (stream.match(/\$params\b/)) return "keyword"
    if (stream.match(/\bout\b/)) return "propertyName"
    if (stream.match(/[a-zA-Z_$][\w$]*/)) return "variableName"
    if (stream.match(/[.[\](),:]/)) return "punctuation"
    if (stream.match(/===|!==|==|!=|<=|>=|&&|\|\||[+\-*/<>!]/)) return "operator"
    stream.next()
    return null
  },
}

export const workflowExpressionLanguage = StreamLanguage.define(expressionStreamParser)
