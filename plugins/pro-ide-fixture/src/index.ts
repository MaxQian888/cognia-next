/**
 * Pro IDE contribution fixture (ADR-0088 Phase 3).
 *
 * This plugin exists to prove one thing that unit tests structurally cannot: the
 * managed Pro IDE pathway works end to end. That chain is
 *
 *   manifest.ide
 *     → normalizeIdeManifest        (lib/plugin/ide/manifest)
 *     → buildProxy + ed25519 sign   (src-tauri/.../proxy.rs)
 *     → --install-extension         (src-tauri/.../process.rs)
 *     → broker hello + catalog hash (src-tauri/.../agent_channel.rs)
 *     → contribution render         (the generated proxy's package.json)
 *     → provider round-trip         (sidecar/codeserver-agent-ext/provider-adapters)
 *     → this file
 *
 * — roughly 150k of Rust, TypeScript and JavaScript that, before this fixture,
 * had no first-party consumer at all. Every layer had its own unit tests and the
 * whole never ran.
 *
 * `code-lens` is the chosen provider because one lens proves both directions in
 * a single visible artifact: the editor pulls lenses from the plugin runtime,
 * and clicking one invokes the plugin's contributed *command* back. A `hover`
 * would have been cheaper and proved half as much.
 *
 * Deliberately trivial otherwise. It is a fixture, not a feature: it ships no
 * product surface, so it can be changed freely when the pathway changes, which
 * is exactly the property a regression harness needs.
 */

/**
 * The command id as the EDITOR knows it.
 *
 * Contributions are declared plugin-locally (`"ping"`) and the proxy compiler
 * namespaces them to `cognia.<pluginId>.<local>`; a lens has to point at the
 * namespaced form, because by the time VS Code resolves the click the local
 * name no longer exists. Pre-prefixing the manifest entry instead produced
 * `cognia.<id>.<id>.ping` — a command that renders and then does nothing.
 */
export const FIXTURE_PING_COMMAND = "cognia.cognia-pro-ide-fixture.ping"

/** Shape the broker hands a `code-lens` provider. */
export interface FixtureLensRequest {
  /** Absolute path of the document the editor is asking about. */
  path: string
  /** Total line count, so the fixture can prove it received real document state. */
  lineCount: number
}

/** One lens, in the shape `provider-adapters.mjs` maps onto `vscode.CodeLens`. */
export interface FixtureLens {
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number }
  command: { command: string; title: string; arguments?: unknown[] }
}

/**
 * Annotate the first line of every file with one lens.
 *
 * Always exactly one, at a fixed position: a fixture that produced lenses
 * conditionally would make a broken round-trip and an empty result look
 * identical, and "no lens appeared" is the failure this is here to catch.
 *
 * The title echoes the request back so the round-trip is visible in the editor
 * rather than only in a log — if the lens says the right filename and line
 * count, the document state genuinely crossed the broker.
 */
export function provideFixtureLenses(request: FixtureLensRequest): FixtureLens[] {
  const name = request.path.split(/[/\\]/).pop() ?? request.path
  return [
    {
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      command: {
        command: FIXTURE_PING_COMMAND,
        title: `Cognia fixture: ${name} (${request.lineCount} lines)`,
        arguments: [{ path: request.path }],
      },
    },
  ]
}

/** Handler for the contributed command; returns what the click carried. */
export function ping(argument?: { path?: string }): { ok: true; path: string | null } {
  return { ok: true, path: argument?.path ?? null }
}

/** The plugin runtime resolves provider handlers off this default export. */
const fixture = { provideFixtureLenses, ping }
export default fixture
