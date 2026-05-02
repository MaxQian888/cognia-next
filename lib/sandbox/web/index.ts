/**
 * Web sandbox runtime stub.
 *
 * cognia-next does not yet ship a Pyodide / Worker-based code-execution
 * sandbox; the plugin sandbox layer asks for one when a plugin calls
 * `executeCode(language, code)`. We expose the service interface here
 * with `isAvailable()` returning false, so the plugin layer surfaces a
 * clear error rather than a `Cannot find module` fault. When the real
 * runtime ships, replace this file's body and the rest stays compatible.
 */

import type { SandboxExecutionResult } from "@/types/system/sandbox"

export interface WebSandboxRequest {
  language: string
  code: string
}

export interface WebSandboxService {
  isAvailable(): boolean
  isLanguageSupported(language: string): boolean
  execute(request: WebSandboxRequest): Promise<SandboxExecutionResult>
}

const stub: WebSandboxService = {
  isAvailable: () => false,
  isLanguageSupported: () => false,
  execute: async (req) => ({
    ok: false,
    error: `Web sandbox is not yet available; cannot execute ${req.language}.`,
    durationMs: 0,
  }),
}

export function getWebSandboxService(): WebSandboxService {
  return stub
}
