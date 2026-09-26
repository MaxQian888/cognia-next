// `@vscode/ripgrep` is optional and ships no types; `rg.ts` imports it
// dynamically and reads only the binary path.
declare module "@vscode/ripgrep" {
  export const rgPath: string | undefined
  const defaultExport: { rgPath?: string } | undefined
  export default defaultExport
}
