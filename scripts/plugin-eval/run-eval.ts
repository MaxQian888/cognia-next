/**
 * Plugin AI-tool eval runner — `pnpm plugin:eval <pluginPath> [--online]`.
 *
 * Discovers `<pluginPath>/evals.yaml`, validates it against the eval schema,
 * and (offline) runs each case against the plugin's tools.
 *
 * Execution model:
 *   - **Structural validation always runs** — a malformed `evals.yaml` fails CI
 *     even if no tool can be executed standalone.
 *   - **Offline execution** needs a runtime-free tool resolver because real
 *     plugin entry modules import the app (`@/lib/...`, Zustand stores) and
 *     can't be loaded outside Next. A plugin opts in by shipping
 *     `evals.harness.mjs` next to `evals.yaml`, exporting
 *     `invokeTool(name, args)` that returns the tool's output. Without it the
 *     runner validates only and says so.
 *   - **Online mode** (`--online`) needs a real model + OAuth token and the
 *     in-app dispatch path, so it is not available from this standalone runner;
 *     it is exercised from inside the app. The flag prints guidance and exits 0.
 *
 * Exit code: non-zero if the suite is malformed or any offline case fails.
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parse as parseYaml } from "yaml"

import {
  parseEvalSuite,
  runEvalSuite,
  type EvalResult,
  type OfflineDeps,
} from "../../lib/plugin/eval/eval-runner"

interface Harness {
  invokeTool: OfflineDeps["invokeTool"]
}

function fail(message: string): never {
  console.error(`[plugin:eval] ${message}`)
  process.exit(1)
}

async function loadHarness(pluginDir: string): Promise<Harness | null> {
  for (const name of ["evals.harness.mjs", "evals.harness.js"]) {
    const file = join(pluginDir, name)
    if (!existsSync(file)) continue
    const mod = (await import(pathToFileURL(file).href)) as Partial<Harness>
    if (typeof mod.invokeTool !== "function") {
      fail(`${name} must export an \`invokeTool(name, args)\` function`)
    }
    return { invokeTool: mod.invokeTool }
  }
  return null
}

function printResults(results: EvalResult[]): number {
  let failed = 0
  for (const r of results) {
    if (r.passed) {
      console.log(`  PASS  ${r.name}`)
    } else {
      failed++
      console.log(`  FAIL  ${r.name}`)
      for (const f of r.failures) console.log(`        ↳ ${f}`)
    }
  }
  console.log(`\n[plugin:eval] ${results.length - failed}/${results.length} passed`)
  return failed
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const online = args.includes("--online")
  const pluginArg = args.find((a) => !a.startsWith("--"))
  if (!pluginArg) fail("usage: pnpm plugin:eval <pluginPath> [--online]")

  const pluginDir = resolve(pluginArg)
  const evalsFile = ["evals.yaml", "evals.yml"]
    .map((n) => join(pluginDir, n))
    .find((f) => existsSync(f))

  if (!evalsFile) {
    console.log(`[plugin:eval] no evals.yaml in ${pluginDir} — nothing to run`)
    return
  }

  let suite
  try {
    suite = parseEvalSuite(parseYaml(readFileSync(evalsFile, "utf8")))
  } catch (err) {
    fail(`invalid evals file: ${err instanceof Error ? err.message : String(err)}`)
  }
  console.log(`[plugin:eval] ${suite.evals.length} case(s) in ${evalsFile}`)

  if (online) {
    console.log(
      "[plugin:eval] --online needs a real model + the in-app dispatch path; run online " +
        "evals from inside the app. Structural validation passed."
    )
    return
  }

  const harness = await loadHarness(pluginDir)
  if (!harness) {
    console.log(
      "[plugin:eval] no evals.harness.mjs found — validated structure only. Add a harness " +
        "exporting `invokeTool(name, args)` to execute offline cases."
    )
    return
  }

  const results = await runEvalSuite(suite, "offline", { invokeTool: harness.invokeTool })
  const failed = printResults(results)
  if (failed > 0) process.exit(1)
}

void main()
