import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REQUIREMENTS = [
  ["types/plugin/plugin.ts", '"selection"', "selection surface type"],
  ["packages/plugin-sdk/contract/catalog.json", '"selection:read"', "canonical permission"],
  [
    "packages/plugin-sdk/src/api/quick-action.ts",
    "PluginSelectionActionSpec",
    "TypeScript SDK export",
  ],
  ["plugin-sdk/python/src/cognia/agent.py", '"selection"', "Python SDK helper"],
  [
    "lib/selection/plugin-actions.ts",
    "executePluginSelectionQuickAction",
    "host execution boundary",
  ],
  ["plugins/ui-surface-reference/src/index.tsx", "selectionReferenceActions", "reference examples"],
]

export function evaluateSelectionActionParity(readFile) {
  return REQUIREMENTS.flatMap(([file, marker, description]) => {
    const source = readFile(file)
    return source.includes(marker) ? [] : [`${file}: missing ${description} (${marker})`]
  })
}

export function checkSelectionActionParity(root) {
  return evaluateSelectionActionParity((file) => fs.readFileSync(path.join(root, file), "utf8"))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const issues = checkSelectionActionParity(root)
  if (issues.length > 0) {
    console.error(issues.join("\n"))
    process.exitCode = 1
  } else {
    console.log("selection action parity: ok")
  }
}
