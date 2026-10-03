/**
 * The parts of the `vscode` API the shim mounts but Cognia does not provide,
 * each with the reason an extension author (and the user) is given.
 *
 * A key is a namespace (`debug`: every member), a namespace member
 * (`window.registerTreeDataProvider`) or a top-level export. Each one is
 * still present on the shim, so an extension that feature-detects or
 * registers at activation keeps running; calling it either throws
 * `NotSupportedError` or registers something nothing uses, as its module
 * documents.
 *
 * `scripts/gates/check-vscode-api-coverage.mjs` holds this list to the
 * `@types/vscode` the shim targets: every key must name real API that the
 * shim mounts, and the generated coverage report
 * (`lib/plugin/vscode-shim/vscode-api-coverage.generated.json`) lists it as
 * unsupported rather than implemented.
 */
export const UNSUPPORTED_VSCODE_API: Readonly<Record<string, string>> = {
  debug: "Cognia has no debugger.",
  scm: "Cognia's source control does not take providers from extensions.",
  tests: "Cognia has no test explorer.",
  comments: "Cognia's editor has no comment threads.",
  notebooks: "Cognia has no notebooks.",
}
