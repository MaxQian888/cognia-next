import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { createGitHubClient } from "../feishu/github.mjs"

const REPORT_DATA = new Set(["playwright-json", "coverage-report", "bundle-size"])

/** Baselines supply comparison data, never the current run's JUnit results. */
export function selectReportArtifacts(artifacts, scope) {
  if (!["current", "baseline"].includes(scope)) throw new Error("Invalid report artifact scope")
  if (
    !Array.isArray(artifacts) ||
    artifacts.some((item) => !item || typeof item.name !== "string")
  ) {
    throw new Error("Invalid report artifact metadata")
  }
  const selected = artifacts.filter(
    ({ name }) => REPORT_DATA.has(name) || (scope === "current" && /^jest-shard-\d+$/.test(name))
  )
  for (const artifact of selected) {
    if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0)
      throw new Error("Invalid report artifact identifier")
    if (artifact.expired !== false)
      throw new Error(`Report artifact is expired or expiration is unknown: ${artifact.name}`)
  }
  return selected
}
/** Only an authenticated, complete listing can establish that inputs are absent. */
export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const { values } = parseArgs({
    args: argv,
    options: {
      scope: { type: "string" },
      "run-id": { type: "string" },
      verify: { type: "boolean" },
      directory: { type: "string" },
    },
    strict: true,
  })
  selectReportArtifacts([], values.scope)
  if (!env.REPORT_ARTIFACT_MANIFEST) throw new Error("REPORT_ARTIFACT_MANIFEST is required")
  if (values.verify) {
    if (!values.directory) throw new Error("--directory is required to verify downloads")
    const manifest = JSON.parse(readFileSync(env.REPORT_ARTIFACT_MANIFEST, "utf8"))
    if (manifest.scope !== values.scope) throw new Error("Report artifact manifest scope mismatch")
    const selected = selectReportArtifacts(manifest.artifacts, values.scope)
    for (const artifact of selected) {
      const directory = path.join(values.directory, artifact.name)
      if (
        !statSync(directory, { throwIfNoEntry: false })?.isDirectory() ||
        !readdirSync(directory).length
      ) {
        throw new Error(`Selected report artifact was not downloaded: ${artifact.name}`)
      }
    }
    return
  }
  if (!values["run-id"] || !env.GITHUB_OUTPUT)
    throw new Error("--run-id and GITHUB_OUTPUT are required")
  const client = createGitHubClient({
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    fetchImpl,
  })
  const selected = selectReportArtifacts(
    await client.listArtifacts({ runId: values["run-id"] }),
    values.scope
  )
  mkdirSync(path.dirname(env.REPORT_ARTIFACT_MANIFEST), { recursive: true })
  writeFileSync(
    env.REPORT_ARTIFACT_MANIFEST,
    JSON.stringify({ scope: values.scope, artifacts: selected })
  )
  // download-artifact v8 flattens singleton ID downloads even with merge-multiple:false.
  const singleName = selected.length === 1 ? selected[0].name : ""
  appendFileSync(
    env.GITHUB_OUTPUT,
    `artifact-ids=${selected.map(({ id }) => id).join(",")}\ncount=${selected.length}\nsingle-name=${singleName}\n`
  )
  console.log(`Report artifacts (${values.scope}): ${selected.length} selected`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[select-report-artifacts] ${error.message}\n`)
    process.exitCode = 1
  })
}
