import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

const SOURCE_ROOTS = ["app", "lib", "components", "hooks", "stores"]
const ALLOWED = new Set(["lib/connectors/delivery-gateway.ts", "lib/db/outbound-jobs.ts"])

function sourceFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!/\.tsx?$/.test(entry.name) || /\.(?:test|stories)\.tsx?$/.test(entry.name)) return []
    return [path]
  })
}

describe("ConnectorDeliveryGateway static gate", () => {
  it("keeps raw outbound persistence private to the gateway", () => {
    const violations = SOURCE_ROOTS.flatMap(sourceFiles)
      .map((path) => ({ path: relative(process.cwd(), path), source: readFileSync(path, "utf8") }))
      .filter(({ path }) => !ALLOWED.has(path))
      .filter(
        ({ source }) =>
          /import\s*\{[^}]*\benqueueOutbound(?:Many)?\b[^}]*\}\s*from\s*["']@\/lib\/db\/outbound-jobs["']/.test(
            source
          ) ||
          /\{[^}]*\benqueueOutbound(?:Many)?\b[^}]*\}\s*=\s*await\s+import\(["']@\/lib\/db\/outbound-jobs["']\)/.test(
            source
          )
      )
      .map(({ path }) => path)

    expect(violations).toEqual([])
  })
})
