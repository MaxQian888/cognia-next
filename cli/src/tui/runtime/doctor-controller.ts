/**
 * `/doctor` controller — gathers an environment health report and opens the
 * `DoctorPanel` overlay. Reuses the credential store
 * (`listCredentialProviders`), the `providerAuthMode` helper, the shared model
 * catalog, and the new crash-log discovery module. All fs/os effects are
 * injectable for tests.
 */
import fs from "node:fs"
import path from "node:path"

import { buildCustomProviderContract } from "@cognia/provider-core/providers/provider-contract-matrix"
import { buildProviderOperationProfile } from "@cognia/provider-core/operations/capability-matrix"
import { isBuiltInProviderId } from "@cognia/provider-types/built-in-provider-catalog"
import type { ProviderOperationProfile } from "@cognia/provider-types"

import { catalogModelIds } from "@/lib/ai/model-options"
import { PROVIDER_OPERATION_MANIFEST } from "@/lib/ai/operations/manifest"
import {
  getPresetConfig,
  resolvePreferredCodexExecutablePresetId,
} from "@/lib/ai/agent/external/presets"

import { listCredentialProviders } from "../../config/credentials"
import { providerAuthMode } from "../commands/builtins"
import { resolveActiveModel } from "../../config/active-model"
import { commandExists } from "../../runtime/external/node-backend"
import {
  findSandboxLauncher,
  sandboxSupportsPlatform,
} from "../../runtime/external/sandbox-launcher"
import type { ResolvedConfig } from "../../config/schema"
import type { CrashReportItem, DoctorReport, TuiAction } from "../state/types"
import { buildCogniaParityReport } from "./cognia-parity-report"
import {
  listCrashReports,
  resolveCrashLogDirs,
  sumLogDirBytes,
  type CrashLogDirs,
  type CrashLogFs,
} from "./crash-log-discovery"
import { snapshotRenderDiagnostics } from "./render-diagnostics"
import { buildDiskReport, type DiskReportDeps } from "./disk-report"

export interface DoctorFacts {
  version: string
  agentBackend: string
  provider: string
  model: string
  auth: string
  modelValid: boolean
  credentialedProviders: string[]
  cwd: string
  dbSnapshotExists: boolean
  dbSnapshotPath: string
  /** The active provider's operation profile (ADR-0163), from the pure matrix. */
  providerOperations?: ProviderOperationsFacts
}

/** Support histogram of the active provider's operation cells. */
export interface ProviderOperationsFacts {
  contractVersion: number
  operations: number
  served: number
  unsupported: number
  unknown: number
}

/**
 * The active provider's operation profile from the pure capability matrix.
 * Sidecar surface only: the TUI has no renderer and no Rust proxy. A custom
 * id gets the contract its configured protocol implies.
 */
export function collectProviderOperationsFacts(
  config: ResolvedConfig,
  profileOf: (providerId: string) => ProviderOperationProfile = defaultOperationProfile(config)
): ProviderOperationsFacts {
  const profile = profileOf(config.provider)
  let served = 0
  let unsupported = 0
  let unknown = 0
  for (const cell of profile.cells) {
    if (cell.support === "unsupported") unsupported += 1
    else if (cell.support === "unknown") unknown += 1
    else served += 1
  }
  return {
    contractVersion: PROVIDER_OPERATION_MANIFEST.schemaVersion,
    operations: PROVIDER_OPERATION_MANIFEST.operations.length,
    served,
    unsupported,
    unknown,
  }
}

function defaultOperationProfile(
  config: ResolvedConfig
): (providerId: string) => ProviderOperationProfile {
  return (providerId) => {
    const protocol = config.providers?.[providerId]?.protocol
    return buildProviderOperationProfile({
      providerId,
      descriptors: PROVIDER_OPERATION_MANIFEST.operations,
      hostSurfaces: ["sidecar"],
      ...(isBuiltInProviderId(providerId)
        ? {}
        : {
            contract: buildCustomProviderContract({
              id: providerId,
              protocol: protocol === "google" ? "gemini" : (protocol ?? "openai"),
            }),
          }),
    })
  }
}

const ok = (b: boolean): string => (b ? "✓" : "✗")

/** Render the doctor report from already-gathered facts (pure). Kept for tests
 * and for any caller that wants a compact text summary. */
export function buildDoctorReport(facts: DoctorFacts): string {
  const modelNote = facts.modelValid ? "" : " (not in this provider's catalog)"
  return [
    `cognia-agent v${facts.version}`,
    `  Backend:      ${facts.agentBackend}`,
    `  Provider:     ${facts.provider}`,
    `  Model:        ${facts.model} ${ok(facts.modelValid)}${modelNote}`,
    `  Credential:   ${facts.auth}`,
    `  Credentialed: ${facts.credentialedProviders.length ? facts.credentialedProviders.join(", ") : "none"}`,
    `  Working dir:  ${facts.cwd}`,
    `  Local store:  ${ok(facts.dbSnapshotExists)} ${facts.dbSnapshotPath}`,
    ...(facts.providerOperations
      ? [
          `  Provider ops: ${facts.providerOperations.served} served / ${facts.providerOperations.unsupported} unsupported / ${facts.providerOperations.unknown} unknown (contract v${facts.providerOperations.contractVersion})`,
        ]
      : []),
  ].join("\n")
}

export interface DoctorDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  /** Config home (`~/.cognia`). */
  home: string
  version: string
  listCredentialed?: (home: string) => string[]
  fileExists?: (p: string) => boolean
  modelCatalog?: (provider: string) => string[]
  /** Operation profile per provider (tests). Defaults to the pure matrix. */
  operationProfile?: (providerId: string) => ProviderOperationProfile
}

/** Runtime dependencies needed for the full `/doctor` overlay (config facts plus
 * cross-platform data-local crash/log discovery). */
export interface DoctorReportDeps extends DoctorDeps {
  /** Platform / env / homedir for resolving the Tauri data-local directory. */
  os: { platform: () => NodeJS.Platform; homedir: () => string }
  env: Record<string, string | undefined>
  /** Injected fs shim for crash/log discovery. */
  crashLogFs?: CrashLogFs
  checkExternalCommand?: (command: string) => Promise<boolean>
  /** Probe for the strict-sandbox launcher (injected in tests). */
  findLauncher?: () => string | undefined
  /** Whether this platform can host external agents (injected in tests). */
  platformSupportsSandbox?: (platform: NodeJS.Platform) => boolean
  /** The chat session id, so the report can read that session's live Cognia
   * parity facts rather than describing the preset in the abstract. */
  sessionId?: string
  /** Injected in tests; defaults to the live tool-host registry. */
  readParity?: typeof buildCogniaParityReport
  /** Read-only filesystem facade for the disk report (tests). */
  diskFs?: DiskReportDeps["fsx"]
  statfs?: DiskReportDeps["statfs"]
}

/**
 * Gather the environment facts (pure-ish: only the injected fs/credential reads).
 * Shared by `/doctor` and the `/status` panel.
 */
export function collectDoctorFacts(deps: DoctorDeps): DoctorFacts {
  const cfg = deps.config
  const credentialed = (deps.listCredentialed ?? listCredentialProviders)(deps.home)
  const exists = deps.fileExists ?? ((p) => fs.existsSync(p))
  const catalog = (deps.modelCatalog ?? catalogModelIds)(cfg.provider)
  // The model that will actually be dispatched (active provider's resolved
  // model), not the legacy top-level pin that can hold another provider's id.
  const activeModel = resolveActiveModel(cfg)
  const dbSnapshotPath = path.join(deps.home, "db.json")
  return {
    version: deps.version,
    agentBackend: cfg.agentBackend ?? "builtin",
    provider: cfg.provider,
    model: activeModel ?? "default",
    auth: providerAuthMode(cfg, cfg.provider),
    modelValid: !activeModel || catalog.length === 0 || catalog.includes(activeModel),
    credentialedProviders: credentialed,
    cwd: cfg.cwd,
    dbSnapshotExists: exists(dbSnapshotPath),
    dbSnapshotPath,
    providerOperations: collectProviderOperationsFacts(
      cfg,
      deps.operationProfile ?? defaultOperationProfile(cfg)
    ),
  }
}

/** Gather crash/log diagnostics from the Tauri data-local directory. */
function collectCrashLogFacts(
  deps: DoctorReportDeps
): Pick<
  DoctorReport,
  "crashReportsDir" | "logsDir" | "crashReportCount" | "latestCrash" | "logDirBytes"
> {
  const dirs: CrashLogDirs = resolveCrashLogDirs(deps.os.platform(), deps.env, deps.os.homedir())
  const fs = deps.crashLogFs ?? nodeCrashLogFs

  if (!dirs.crashReportsDir || !dirs.logsDir) {
    return {
      crashReportsDir: dirs.crashReportsDir,
      logsDir: dirs.logsDir,
      crashReportCount: 0,
      logDirBytes: 0,
    }
  }

  const reports = listCrashReports(dirs.crashReportsDir, fs)
  return {
    crashReportsDir: dirs.crashReportsDir,
    logsDir: dirs.logsDir,
    crashReportCount: reports.length,
    latestCrash: reports[0],
    logDirBytes: sumLogDirBytes(dirs.logsDir, fs),
  }
}

const nodeCrashLogFs: CrashLogFs = {
  readdirSync: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  statSync: (p) => fs.statSync(p),
}

/** Assemble the full diagnostic report used by the `DoctorPanel` overlay. */
export function collectDoctorReport(deps: DoctorReportDeps): DoctorReport {
  const facts = collectDoctorFacts(deps)
  const crashLogFacts = collectCrashLogFacts(deps)
  // What Cognia actually managed to project into this backend. Reported here
  // because "the binary is on PATH" says nothing about whether the agent can
  // call a single Cognia tool.
  const parity = deps.sessionId
    ? (deps.readParity ?? buildCogniaParityReport)(deps.sessionId)
    : undefined
  return {
    ...facts,
    ...crashLogFacts,
    tuiRenderer: snapshotRenderDiagnostics(deps.env),
    ...(parity ? { cogniaParity: parity } : {}),
  }
}

export async function runDoctor(deps: DoctorReportDeps): Promise<void> {
  const report = collectDoctorReport(deps)
  // Read-only: the report names the commands that would reclaim space and
  // runs none of them. A failing walk leaves the section out, never the panel.
  try {
    report.disk = await buildDiskReport({
      home: deps.home,
      repoRoot: deps.config.cwd,
      ...(deps.diskFs ? { fsx: deps.diskFs } : {}),
      ...(deps.statfs ? { statfs: deps.statfs } : {}),
    })
  } catch {
    report.disk = undefined
  }
  if (report.agentBackend !== "builtin") {
    // CLI v1 deliberately leaves desktop hook state and ACP terminal methods
    // inactive. Keep the diagnostic report explicit so dormant compatibility
    // shims cannot be mistaken for live capabilities.
    report.externalAgentHooksActive = false
    report.externalAgentTerminalActive = false
    const presetId =
      report.agentBackend === "codex"
        ? await resolvePreferredCodexExecutablePresetId()
        : report.agentBackend
    const command = getPresetConfig(presetId)?.process?.command
    report.externalAgentCommand = command
    report.externalAgentAvailable = command
      ? await (deps.checkExternalCommand ?? commandExists)(command)
      : false
    // The agent binary being on PATH is only half the story: every external
    // process is launched through the strict-sandbox launcher, so a missing
    // launcher (or an unsupported platform) fails every turn while the command
    // check still reads "✓". Report both, or the panel lies.
    report.externalAgentPlatformSupported = (
      deps.platformSupportsSandbox ?? sandboxSupportsPlatform
    )(deps.os.platform())
    report.externalAgentSandboxReady = Boolean((deps.findLauncher ?? findSandboxLauncher)())
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: { kind: "doctor", report },
  })
}

export type { CrashReportItem }
