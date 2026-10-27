import path from "node:path"
import { fileURLToPath } from "node:url"
import { stageNativeAgentBridges } from "./lib/stage-native-agent-bridges.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const result = stageNativeAgentBridges({ root, sidecarOutDir: path.join(root, "sidecar"), pin: process.argv.includes("--pin") })
console.log(`Staged ${Object.keys(result.manifest.bridges).length} verified native bridges and ${Object.keys(result.manifest.dependencyFiles).length} dependency files`)
