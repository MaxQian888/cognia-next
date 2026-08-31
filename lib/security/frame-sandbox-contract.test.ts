/** @jest-environment node */

import { readFileSync } from "node:fs"
import { relative } from "node:path"
import { globSync } from "glob"

describe("untrusted srcDoc iframe sandbox contract", () => {
  it("never combines scripts with same-origin in a srcDoc-owning module", () => {
    const root = process.cwd()
    const candidates = globSync(
      ["components/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
      {
        cwd: root,
        absolute: true,
        ignore: ["**/*.test.*", "**/*.stories.*"],
      }
    )
    const violations = candidates.flatMap((path) => {
      const source = readFileSync(path, "utf8")
      if (!/srcDoc|srcdoc/.test(source)) return []
      const jsxSandbox =
        /sandbox\s*=\s*["'][^"']*(?:allow-scripts[^"']*allow-same-origin|allow-same-origin[^"']*allow-scripts)[^"']*["']/.test(
          source
        )
      const assignedSandbox =
        /setAttribute\(\s*["']sandbox["']\s*,\s*["'][^"']*(?:allow-scripts[^"']*allow-same-origin|allow-same-origin[^"']*allow-scripts)[^"']*["']/.test(
          source
        )
      if (!jsxSandbox && !assignedSandbox) {
        return []
      }
      return [relative(root, path)]
    })

    expect(violations).toEqual([])
  })
})
