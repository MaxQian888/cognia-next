/**
 * `/doctor` controller — a quick environment health check: version, the active
 * provider/model + which credential it will use, whether that model is in the
 * provider's catalog, every provider that has a stored credential, the working
 * directory, and the CLI-local db snapshot. Reuses the credential store
 * (`listCredentialProviders`), the `providerAuthMode` helper, and the shared
 * model catalog. All fs effects are injectable for tests.
 */
import fs from "node:fs"
import path from "node:path"

import { catalogModelIds } from "@/lib/ai/model-options"

import { listCredentialProviders } from "../../config/credentials"
import { providerAuthMode } from "../commands/builtins"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

export interface DoctorFacts {
  version: string
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

/** Render the doctor report from already-gathered facts (pure). */
export function buildDoctorReport(facts: DoctorFacts): string {
  const modelNote = facts.modelValid ? "" : " (not in this provider's catalog)"
  return [
    `cognia-agent v${facts.version}`,
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

export async function runDoctor(deps: DoctorDeps): Promise<void> {
  const cfg = deps.config
  const credentialed = (deps.listCredentialed ?? listCredentialProviders)(deps.home)
  const exists = deps.fileExists ?? ((p) => fs.existsSync(p))
  const catalog = (deps.modelCatalog ?? catalogModelIds)(cfg.provider)
  const dbSnapshotPath = path.join(deps.home, "db.json")
  const facts: DoctorFacts = {
    version: deps.version,
    provider: cfg.provider,
    model: cfg.model ?? "default",
    auth: providerAuthMode(cfg, cfg.provider),
    modelValid: !cfg.model || catalog.length === 0 || catalog.includes(cfg.model),
    credentialedProviders: credentialed,
    cwd: cfg.cwd,
    dbSnapshotExists: exists(dbSnapshotPath),
    dbSnapshotPath,
  }
  deps.dispatch({ type: "NOTICE", message: buildDoctorReport(facts) })
}
