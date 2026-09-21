/**
 * `pnpm router-fusion:live-smoke` (ADR-0188 D4/D20, B5 WP-E3).
 *
 * `scripts/router-fusion/live-smoke.mjs` bundles this module with the CLI's
 * esbuild pipeline and calls `runLiveSmokeCli` with Node's file system behind
 * the `LiveSmokeIo` port; this module never imports a Node built-in itself.
 *
 *  - default (dry run): read the user's settings export, print the providers
 *    and every planned case — routed by the real router, with its cap — and
 *    exit 0. The network is blocked for the whole process, so a dry run
 *    provably makes no call.
 *  - `--fake`: run every case through the real engine against the Fake
 *    Provider, network still blocked; the report is labelled "simulated".
 *  - `--confirm`: run every case against the providers the user confirmed,
 *    with the ledger enforcing the $5 total; the report is labelled "live".
 *    It refuses to start without settings, without a confirmed provider, when
 *    a routed deployment has no credential, or when the cap is not in place.
 *
 * The heavy engine modules are imported only after the IndexedDB and window
 * shims are installed, the same order the headless brain boots in.
 */

import type { RoleCallExecutor } from "@cognia/router-fusion"
import {
  LIVE_SMOKE_USAGE,
  parseLiveSmokeArgs,
  type LiveSmokeArgs,
} from "@cognia/router-fusion/live/args"
import {
  assertLiveCapInPlace,
  formatUsd,
  LIVE_SMOKE_BUDGET_MODE,
  planLiveSmokeCaps,
  type LiveCapPlan,
} from "@cognia/router-fusion/live/cap"
import {
  DELEGATE_FIXTURE_FILES,
  FIXTURE_ACCEPTANCE_PROFILE_ID,
  LIVE_SMOKE_CASES,
} from "@cognia/router-fusion/live/cases"
import type { LiveProviderListing } from "@cognia/router-fusion/live/providers"
import {
  liveSmokeExitCode,
  renderLiveSmokeMarkdown,
  type LiveSmokeReport,
} from "@cognia/router-fusion/live/report"
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"

import { installNetworkGuard, type NetworkGuard } from "./network-guard"

/** The file system, as the script hands it in. Paths are resolved by the script's `path`. */
export interface LiveSmokeIo {
  readText(path: string): Promise<string>
  /** Write a file, creating its parent directories. */
  writeText(path: string, content: string): Promise<void>
  /** A new, empty directory under the OS temp dir. */
  makeTempDir(prefix: string): Promise<string>
  /** Absolute path of the segments, resolved like `path.resolve`. */
  resolvePath(...segments: string[]): string
  /** The OS temp dir. */
  readonly tempRoot: string
}

export interface LiveSmokeCliInput {
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  io: LiveSmokeIo
  out: (line: string) => void
  err: (line: string) => void
  now?: () => number
}

export const REPORT_DIR_NAME = "cognia-router-fusion-live-smoke"
export const REPORT_JSON = "live-smoke-report.json"
export const REPORT_MARKDOWN = "live-smoke-report.md"

/** A refusal to go on that is the user's to fix, not a crash: exit code 2. */
class LiveSmokeRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LiveSmokeRefusal"
  }
}

const REFUSAL_NAMES = new Set(["LiveSmokeRefusal", "LiveCapError", "LiveSmokeSettingsError"])

type Runner = typeof import("./live-smoke-runner")
type CasePreview = Awaited<ReturnType<Runner["previewLiveSmoke"]>>[number]

function planLines(plan: LiveCapPlan, previews: readonly CasePreview[] | null): string[] {
  const lines = [
    `Total cap: ${formatUsd(plan.totalCapMicrousd)}, enforced by the ledger of a dedicated in-memory fusion account (budget mode ${LIVE_SMOKE_BUDGET_MODE})`,
    "Planned cases:",
  ]
  for (const planned of plan.cases) {
    const { definition } = planned
    const preview = previews?.find((entry) => entry.caseId === definition.id)
    const lowered =
      planned.capMicrousd < planned.requestedCapMicrousd
        ? ` (lowered from ${formatUsd(planned.requestedCapMicrousd)} by the ${definition.mode} run cap)`
        : ""
    lines.push(
      `  ${definition.id.padEnd(9)} cap ${formatUsd(planned.capMicrousd)}${lowered}  ${definition.title}`
    )
    if (preview?.status === "selected") {
      const roles = Object.entries(preview.roles)
        .map(([role, deployment]) => `${role}=${deployment}`)
        .join(" ")
      lines.push(
        `            → ${preview.actionId}: ${roles}${
          preview.reserveMicrousd !== null
            ? `, router reserve ${formatUsd(preview.reserveMicrousd)}`
            : ""
        }`
      )
      if (preview.missingCredentials.length > 0) {
        lines.push(
          `            ! no usable credential for ${preview.missingCredentials.join(", ")}`
        )
      }
      if (preview.unconfirmed.length > 0) {
        lines.push(
          `            ! outside the confirmed providers: ${preview.unconfirmed.join(", ")}`
        )
      }
    } else if (preview) {
      lines.push(`            → ${preview.detail}`)
      if (preview.reasons.length > 0) {
        lines.push(`              router: ${preview.reasons.join(", ")}`)
      }
    }
    if (definition.usesFixtureRepo) {
      lines.push(
        `            fixture repository: ${Object.keys(DELEGATE_FIXTURE_FILES).length} files with acceptance profile "${FIXTURE_ACCEPTANCE_PROFILE_ID}", written to a new temp dir when the smoke runs`
      )
    }
  }
  lines.push(
    `Σ case caps ${formatUsd(plan.plannedMicrousd)} of the ${formatUsd(plan.totalCapMicrousd)} total`
  )
  return lines
}

function providerLines(providers: readonly LiveProviderListing[]): string[] {
  if (providers.length === 0) return ["Providers: none configured"]
  return [
    "Providers:",
    ...providers.map(
      (provider) =>
        `  [${provider.selected ? "x" : " "}] ${provider.id.padEnd(16)} ${provider.kind}, ${
          provider.enabled ? "enabled" : "disabled"
        }, key ${provider.credentialEnv}: ${provider.credentialFound ? "found" : "missing"}`
    ),
  ]
}

async function createFixtureRepo(io: LiveSmokeIo): Promise<string> {
  const root = await io.makeTempDir("cognia-live-smoke-fixture-")
  for (const [relative, content] of Object.entries(DELEGATE_FIXTURE_FILES)) {
    await io.writeText(io.resolvePath(root, relative), content)
  }
  return root
}

async function writeReport(
  io: LiveSmokeIo,
  outDir: string | null,
  report: LiveSmokeReport
): Promise<string> {
  const stamp = report.generatedAt.replace(/[:.]/g, "-")
  const dir = outDir
    ? io.resolvePath(outDir)
    : io.resolvePath(io.tempRoot, REPORT_DIR_NAME, `${stamp}-${report.label}`)
  await io.writeText(io.resolvePath(dir, REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`)
  await io.writeText(io.resolvePath(dir, REPORT_MARKDOWN), renderLiveSmokeMarkdown(report))
  return dir
}

function summaryLines(report: LiveSmokeReport, dir: string): string[] {
  return [
    `Report (${report.label}): ${dir}`,
    ...report.cases.map(
      (entry) =>
        `  ${entry.id.padEnd(9)} ${entry.outcome.padEnd(9)} spent ${formatUsd(entry.spentMicrousd)}  ${entry.detail}`
    ),
    `Spent ${formatUsd(report.totalSpentMicrousd)} of ${formatUsd(report.totalCapMicrousd)}; network ${report.network.mode}: ${report.network.requests} request(s), ${report.network.blocked} blocked`,
  ]
}

async function loadLiveSettings(input: LiveSmokeCliInput, args: LiveSmokeArgs) {
  const { parseSettingsExport, prepareLiveSettings } = await import("./live-smoke-settings")
  if (!args.settingsPath) return null
  const path = input.io.resolvePath(args.settingsPath)
  const base = parseSettingsExport(await input.io.readText(path))
  const prepared = prepareLiveSettings(base, {
    env: input.env,
    requestedProviders: args.providers,
  })
  if (prepared.unknownRequested.length > 0) {
    throw new LiveSmokeRefusal(
      `--providers names providers the settings do not configure: ${prepared.unknownRequested.join(", ")}`
    )
  }
  return { path, prepared }
}

function capPlanFor(runCapUsdByMode: Parameters<typeof planLiveSmokeCaps>[1]): LiveCapPlan {
  const plan = planLiveSmokeCaps(LIVE_SMOKE_CASES, runCapUsdByMode)
  assertLiveCapInPlace(plan)
  return plan
}

async function dryRun(
  input: LiveSmokeCliInput,
  args: LiveSmokeArgs,
  runner: Runner,
  network: NetworkGuard
): Promise<number> {
  const { normalizeRouterFusionSettings } = await import("@cognia/router-fusion/settings/settings")
  input.out("Router + Fusion live smoke: DRY RUN (network blocked, nothing is spent)")
  const loaded = await loadLiveSettings(input, args)
  if (!loaded) {
    input.out(
      "Providers: unknown (no settings export given: pass --settings <file> or set COGNIA_LIVE_SMOKE_SETTINGS)"
    )
    const { DEFAULT_ROUTER_FUSION_SETTINGS } =
      await import("@cognia/router-fusion/settings/settings")
    for (const line of planLines(
      capPlanFor(DEFAULT_ROUTER_FUSION_SETTINGS.runCapUsdByMode),
      null
    )) {
      input.out(line)
    }
    input.out(`Network requests during this dry run: ${network.records.length}`)
    return 0
  }
  const { path, prepared } = loaded
  input.out(`Settings: ${path}`)
  for (const line of providerLines(prepared.providers)) input.out(line)
  const plan = capPlanFor(
    normalizeRouterFusionSettings(prepared.appSettings.routerFusion).runCapUsdByMode
  )
  const previews =
    prepared.selected.length > 0
      ? await runner.previewLiveSmoke({
          routeHost: runner.createLiveRouteHost(prepared.appSettings),
          appSettings: prepared.appSettings,
          plan,
          allowedProviderIds: prepared.selected,
          checkCredentials: true,
        })
      : null
  if (!previews) input.out("No provider is selected, so no case can be routed.")
  for (const line of planLines(plan, previews)) input.out(line)
  input.out(`Network requests during this dry run: ${network.records.length}`)
  input.out(
    `To run it for real (spends at most ${formatUsd(plan.totalCapMicrousd)}): pnpm router-fusion:live-smoke --settings ${path} --providers ${
      prepared.selected.join(",") || "<ids>"
    } --confirm`
  )
  return 0
}

async function simulatedRun(
  input: LiveSmokeCliInput,
  args: LiveSmokeArgs,
  runner: Runner,
  network: NetworkGuard,
  now: () => number
): Promise<number> {
  const [
    { createSimulatedRouteHost, simulatedAppSettings },
    { simulatedProvider, simulatedProviderListing, SIMULATED_PROVIDER_ID },
    { normalizeRouterFusionSettings },
  ] = await Promise.all([
    import("./simulated-route-host"),
    import("@cognia/router-fusion/live/simulated"),
    import("@cognia/router-fusion/settings/settings"),
  ])
  input.out("Router + Fusion live smoke: SIMULATED (Fake Provider, network blocked)")
  const appSettings = simulatedAppSettings()
  const newId = () => globalThis.crypto.randomUUID()
  const routeHost = createSimulatedRouteHost(appSettings, { now, newId })
  const plan = capPlanFor(normalizeRouterFusionSettings(appSettings.routerFusion).runCapUsdByMode)
  for (const line of planLines(plan, null)) input.out(line)
  const fixtureRoot = await createFixtureRepo(input.io)
  const report = await runner.runLiveSmoke({
    label: "simulated",
    appSettings,
    routeHost,
    executor: simulatedProvider(),
    plan,
    providers: [simulatedProviderListing()],
    allowedProviderIds: [SIMULATED_PROVIDER_ID],
    fixtureRoot,
    network,
    now,
    newId,
    log: (line) => input.out(`  ${line}`),
  })
  const dir = await writeReport(input.io, args.outDir, report)
  for (const line of summaryLines(report, dir)) input.out(line)
  return liveSmokeExitCode(report)
}

async function confirmedRun(
  input: LiveSmokeCliInput,
  args: LiveSmokeArgs,
  runner: Runner,
  network: NetworkGuard,
  now: () => number
): Promise<number> {
  const [{ normalizeRouterFusionSettings }, { createRoleCallExecutor }] = await Promise.all([
    import("@cognia/router-fusion/settings/settings"),
    import("../calls/role-call-executor"),
  ])
  input.out("Router + Fusion live smoke: LIVE (real providers, ledger-enforced total cap)")
  const loaded = await loadLiveSettings(input, args)
  if (!loaded) {
    throw new LiveSmokeRefusal(
      "--confirm needs the settings export: pass --settings <file> or set COGNIA_LIVE_SMOKE_SETTINGS"
    )
  }
  const { path, prepared } = loaded
  input.out(`Settings: ${path}`)
  for (const line of providerLines(prepared.providers)) input.out(line)
  if (prepared.selected.length === 0) {
    throw new LiveSmokeRefusal(
      "no provider is confirmed: name them with --providers and set COGNIA_LIVE_SMOKE_KEY_<PROVIDER> for each"
    )
  }
  const plan = capPlanFor(
    normalizeRouterFusionSettings(prepared.appSettings.routerFusion).runCapUsdByMode
  )
  const routeHost = runner.createLiveRouteHost(prepared.appSettings)
  const previews = await runner.previewLiveSmoke({
    routeHost,
    appSettings: prepared.appSettings,
    plan,
    allowedProviderIds: prepared.selected,
    checkCredentials: true,
  })
  for (const line of planLines(plan, previews)) input.out(line)
  const blocked = previews.filter(
    (preview) =>
      preview.status === "error" ||
      preview.missingCredentials.length > 0 ||
      preview.unconfirmed.length > 0
  )
  if (blocked.length > 0) {
    throw new LiveSmokeRefusal(
      `a case could not be routed, or a routed deployment has no credential or is outside the confirmed providers (${blocked
        .map((preview) => preview.caseId)
        .join(", ")}); nothing was sent`
    )
  }
  input.out(
    `Running against ${prepared.selected.join(", ")}; at most ${formatUsd(plan.totalCapMicrousd)} can be spent.`
  )
  const fixtureRoot = await createFixtureRepo(input.io)
  const executor: RoleCallExecutor = createRoleCallExecutor({
    appSettings: prepared.appSettings,
    now,
  })
  const report = await runner.runLiveSmoke({
    label: "live",
    appSettings: prepared.appSettings,
    routeHost,
    executor,
    plan,
    providers: prepared.providers,
    allowedProviderIds: prepared.selected,
    fixtureRoot,
    network,
    now,
    log: (line) => input.out(`  ${line}`),
  })
  const dir = await writeReport(input.io, args.outDir, report)
  for (const line of summaryLines(report, dir)) input.out(line)
  return liveSmokeExitCode(report)
}

export async function runLiveSmokeCli(input: LiveSmokeCliInput): Promise<number> {
  const now = input.now ?? (() => Date.now())
  const parsed = parseLiveSmokeArgs(input.argv, input.env)
  if (!parsed.ok) {
    input.err(`live-smoke: ${parsed.message}`)
    input.err(LIVE_SMOKE_USAGE)
    return 2
  }
  const { args } = parsed
  if (args.command === "help") {
    input.out(LIVE_SMOKE_USAGE)
    return 0
  }

  // Only a confirmed run may reach the network; everything else is blocked.
  const network = installNetworkGuard(args.command === "live" ? "observe" : "block", { now })
  try {
    await installFakeIndexedDb()
    const runner = await import("./live-smoke-runner")
    if (args.command === "simulated") return await simulatedRun(input, args, runner, network, now)
    if (args.command === "live") return await confirmedRun(input, args, runner, network, now)
    return await dryRun(input, args, runner, network)
  } catch (error) {
    if (error instanceof Error && REFUSAL_NAMES.has(error.name)) {
      input.err(`live-smoke: refusing to start: ${error.message}`)
      return 2
    }
    throw error
  } finally {
    network.restore()
  }
}
