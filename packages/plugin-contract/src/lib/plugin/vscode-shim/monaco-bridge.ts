/**
 * The plugin contract's share of `lib/plugin/vscode-shim/monaco-bridge.ts`, which re-exports these.
 */

export interface MonacoRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface MonacoMarker {
  severity: "error" | "warning" | "info" | "hint"
  message: string
  range: MonacoRange
  source?: string
}
