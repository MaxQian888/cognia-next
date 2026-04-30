/**
 * Canvas Symbol Types — code outline / breadcrumb data shared between
 * `lib/canvas/symbols/symbol-parser.ts` (LSP-style outline used by the
 * Monaco hover / breadcrumb) and any UI consumer.
 *
 * NOTE: `lib/canvas/ai/context-analyzer.ts` keeps its own narrower
 * `AiContextSymbol` shape because it represents the lightweight summary
 * fed to the LLM, not the full IDE outline. Don't unify them.
 */

import type { LineRange } from "./collaboration"

export type SymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "key"
  | "null"
  | "enumMember"
  | "struct"
  | "event"
  | "operator"
  | "typeParameter"

export interface DocumentSymbol {
  name: string
  kind: SymbolKind
  range: LineRange
  selectionRange: LineRange
  detail?: string
  children?: DocumentSymbol[]
  containerName?: string
}

export interface SymbolLocation {
  symbol: DocumentSymbol
  path: string[]
  chain: DocumentSymbol[]
}
