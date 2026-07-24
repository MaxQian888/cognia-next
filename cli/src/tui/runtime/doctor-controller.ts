/**
 * `/doctor` controller — gathers an environment health report and opens the
 * `DoctorPanel` overlay. Reuses the credential store
 * (`listCredentialProviders`), the `providerAuthMode` helper, the shared model
 * catalog, and the new crash-log discovery module. All fs/os effects are
 * injectable for tests.
 */
import fs from "node:fs"
import path from "node:path"

import { catalogModelIds } from "@/lib/ai/model-options"
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
import {
  listCrashReports,
  resolveCrashLogDirs,
  sumLogDirBytes,
  type CrashLogDirs,
  type CrashLogFs,
} from "./crash-log-discovery"

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
  return {
    ...facts,
    ...crashLogFacts,
  }
}

export async function runDoctor(deps: DoctorReportDeps): Promise<void> {
  const report = collectDoctorReport(deps)
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
