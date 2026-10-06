/**
 * Defence in depth for `evaluatePluginCode`: refuse a plugin bundle whose text
 * still names a host-private module.
 *
 * `@/` is this repo's tsconfig alias for its own root. Nothing under it exists
 * outside the monorepo, so any surviving `@/` specifier means the bundle was
 * built against app internals — it will fail at `require()` time with an
 * unreadable error, or worse, silently bind to something the host never meant
 * to publish. Refusing the whole bundle up front names the offending specifier
 * instead.
 *
 * This deliberately matches the ALIAS, not a hand-kept list of directories
 * under it. The previous four-prefix list (`@/lib`, `@/types`, `@/components`,
 * `@/stores`) is exactly why `plugins/web-tools` could reach
 * `@/packages/plugin-sdk/src/host` — a subpath the SDK deliberately keeps out
 * of `package.json#exports` and the npm tarball — and still load cleanly.
 *
 * This is the LAST line, not the first: the text scan cannot see an alias that
 * esbuild already resolved and inlined. `cognia plugin build` scans the
 * author's source tree before bundling for that reason, and
 * `pnpm plugin:author-imports` ratchets first-party plugins in CI.
 */

const HOST_PRIVATE_IMPORT_ALIAS = "@/"

const IMPORT_SPECIFIER_PATTERN =
  /(?:from\s*|import\s*\(|require\s*\(|import\s+(?=["']))\s*["']([^"']+)["']/g

function isHostPrivateImport(specifier: string): boolean {
  return specifier.startsWith(HOST_PRIVATE_IMPORT_ALIAS)
}

export function findHostPrivateImports(source: string): string[] {
  const matches: string[] = []
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1]
    if (specifier && isHostPrivateImport(specifier)) {
      matches.push(specifier)
    }
  }
  return matches
}

export function assertNoHostPrivateImports(source: string, sourceName: string): void {
  const imports = findHostPrivateImports(source)
  if (imports.length === 0) return

  throw new Error(
    `Marketplace plugin ${sourceName} imports host-private modules: ${[...new Set(imports)].join(
      ", "
    )}. Use @cognia/plugin-sdk or @cognia/plugin-ui instead.`
  )
}
