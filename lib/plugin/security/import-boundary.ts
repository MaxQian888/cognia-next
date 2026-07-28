const HOST_PRIVATE_IMPORT_PREFIXES = ["@/lib", "@/types", "@/components", "@/stores"] as const

const IMPORT_SPECIFIER_PATTERN =
  /(?:from\s*|import\s*\(|require\s*\(|import\s+(?=["']))\s*["']([^"']+)["']/g

function isHostPrivateImport(specifier: string): boolean {
  return HOST_PRIVATE_IMPORT_PREFIXES.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  )
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
