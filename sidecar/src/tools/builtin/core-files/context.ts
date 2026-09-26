// The session state the core file tools share. `createCoreTools` builds one
// context per session and hands it to every tool factory.

import type { ReadTracker } from "../../state/read-tracker.ts"

/** The slice of an LSP resolver the post-write diagnostics read. */
export interface DiagnosticsSource {
  getDiagnostics(absPath: string): Promise<unknown[]>
}

export interface CoreFileToolContext {
  /** The session working directory; relative tool paths resolve against it. */
  cwd?: string | undefined
  /** Records reads so write/edit can enforce read-before-write. */
  readTracker?: ReadTracker | undefined
  lspResolver?: DiagnosticsSource | null | undefined
  /** The active model and provider; `read` inlines images only when they accept them. */
  model?: string | undefined
  provider?: string | undefined
}
