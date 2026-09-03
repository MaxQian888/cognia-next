import type { NativeSkill } from "@/lib/claude/ipc"
import type { SessionSummary } from "@/lib/session-import"
import type { SubagentImportDraft } from "@/lib/claude/subagent-importers"
import type {
  MigrationArtifact,
  MigrationArtifactResult,
  MigrationPlan,
  MigrationPreviewCell,
  MigrationVendor,
} from "./types"
import type { PreviewArtifactOutput } from "./run"

export interface ArtifactPreviewDeps {
  previewSettings: (vendor: MigrationVendor) => Promise<unknown[]>
  previewCommands: (vendor: MigrationVendor) => Promise<{ drafts: unknown[]; warnings: string[] }>
  previewSessions: (vendor: MigrationVendor) => Promise<SessionSummary[]>
  previewMcp: (vendor: MigrationVendor, cwd?: string) => Promise<PreviewArtifactOutput>
  previewSubagents: (
    vendor: MigrationVendor
  ) => Promise<{ drafts: SubagentImportDraft[]; warnings: string[] }>
  previewSkills: (vendor: MigrationVendor) => Promise<NativeSkill[]>
  previewMemory: (vendor: MigrationVendor, cwd?: string) => Promise<unknown[]>
}

export interface ArtifactApplyDeps {
  applySettings: (
    items: unknown[],
    strategy: MigrationPlan["strategy"]
  ) => Promise<MigrationArtifactResult>
  applyCommands: (
    items: unknown[],
    strategy: MigrationPlan["strategy"]
  ) => Promise<MigrationArtifactResult>
  applySessions: (
    items: unknown[],
    plan: MigrationPlan,
    signal?: AbortSignal
  ) => Promise<MigrationArtifactResult>
  applyMcp: (
    vendor: MigrationVendor,
    strategy: MigrationPlan["strategy"]
  ) => Promise<MigrationArtifactResult>
  applyProjectMcp: (
    cwd: string,
    strategy: MigrationPlan["strategy"]
  ) => Promise<MigrationArtifactResult>
  applySubagents: (
    items: unknown[],
    strategy: MigrationPlan["strategy"]
  ) => Promise<MigrationArtifactResult>
  applySkills: (
    items: unknown[],
    strategy: MigrationPlan["strategy"]
  ) => Promise<MigrationArtifactResult>
}

async function scanSubagents(
  vendor: MigrationVendor
): Promise<{ drafts: SubagentImportDraft[]; warnings: string[] }> {
  const [
    { resolveVendorRoots },
    { joinPath },
    { realSessionFs, walkFiles },
    importers,
    { configRootKeyForMigrationVendor, subagentSourceIdForMigrationVendor },
  ] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/claude/instructions/paths"),
    import("@/lib/session-import/fs"),
    import("@/lib/claude/subagent-importers"),
    import("@/lib/agent-ecosystem/catalog"),
  ])
  const roots = await resolveVendorRoots()
  // `configRootKey`, not the probe roots. OpenCode keeps config and history in
  // different directories, and the ladder this replaced fell through to
  // `opencodeConfigDir` for every non-Claude, non-Codex, non-Pi vendor, which
  // was correct only because OpenCode happened to be the sole remaining case.
  const rootKey = configRootKeyForMigrationVendor(vendor)
  const base = rootKey ? ((roots as Record<string, string | undefined>)[rootKey] ?? "") : ""
  if (!base) return { drafts: [], warnings: ["Source root is unavailable."] }
  const dir = joinPath(base, "agents")
  const fs = realSessionFs()
  const paths = await walkFiles(fs, dir, (name) => /\.(md|markdown)$/i.test(name))
  const files = []
  const warnings: string[] = []
  for (const path of paths) {
    try {
      files.push({
        filename: path.replace(/\\/g, "/").split("/").pop() ?? path,
        sourcePath: path,
        content: await fs.readTextFile(path),
      })
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Codex's importer is registered as `codex-cli`. That one-character
  // difference used to live in a ternary here.
  const sourceId = subagentSourceIdForMigrationVendor(vendor)
  if (!sourceId) {
    return { drafts: [], warnings: [`No subagent importer is registered for ${vendor}.`] }
  }
  const adapter = importers.getSubagentAdapter(
    sourceId as Parameters<typeof importers.getSubagentAdapter>[0]
  )
  const parsed = adapter.parse({ files, rootDir: dir })
  return {
    drafts: parsed.drafts,
    warnings: [...warnings, ...parsed.errors.map((error) => `${error.filename}: ${error.error}`)],
  }
}

async function discoverMemory(vendor: MigrationVendor, cwd?: string): Promise<unknown[]> {
  const [{ resolveVendorRoots }, memory, home, { realSessionFs }] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/memory/external/discover"),
    import("@/lib/memory/external/home"),
    import("@/lib/session-import/fs"),
  ])
  const resolvedHome = (await home.resolveHome()) ?? ""
  if (!resolvedHome) return []
  const files = await memory.discoverExternalMemory({
    home: resolvedHome,
    roots: cwd ? [cwd] : [],
    cwd,
    platform: home.detectPlatform(),
    fs: realSessionFs(),
    vendorRoots: await resolveVendorRoots(),
  })
  return files.filter((file) => file.agent === vendor)
}

async function defaultPreviewDeps(): Promise<ArtifactPreviewDeps> {
  return {
    previewSettings: async (vendor) =>
      (await import("@/lib/settings-import")).previewSettingsImport(vendor),
    previewCommands: async (vendor) =>
      (await import("@/lib/commands-import")).previewCommandsImport(vendor),
    previewSessions: async (vendor) => {
      const sessions = await import("@/lib/session-import")
      return sessions.listSessionsForSource(vendor, await sessions.resolveScanInput())
    },
    previewMcp: async (vendor, cwd) => {
      const sync = await import("@/lib/claude/sync")
      const user = await sync.previewAgentImport(vendor)
      const project =
        vendor === "claude-code" && cwd ? await sync.previewProjectMcpImport(cwd) : undefined
      return {
        items: [...user.drafts, ...(project?.drafts ?? [])],
        warnings: [user.parseError, project?.parseError].filter(
          (value): value is string => !!value
        ),
        metadata: { project: project?.exists ?? false },
      }
    },
    previewSubagents: scanSubagents,
    previewSkills: async (vendor) => {
      const ipc = await import("@/lib/claude/ipc")
      switch (vendor) {
        case "claude-code":
          return ipc.skillsScanNative()
        case "codex":
          return ipc.skillsScanCodex()
        case "opencode":
          return ipc.skillsScanOpencode()
        case "pi": {
          // Pi discovers skills from the agent-neutral `.agents/skills`
          // convention rather than a Pi-specific directory, so it uses the
          // generic scanner instead of a vendor command.
          const [{ resolveHome }, { joinPath }] = await Promise.all([
            import("@/lib/memory/external/home"),
            import("@/lib/claude/instructions/paths"),
          ])
          const home = (await resolveHome()) ?? ""
          return home ? ipc.skillsScanDir(joinPath(home, ".agents/skills")) : []
        }
      }
      // Exhaustive on purpose. This used to fall through to
      // `skillsScanOpencode()`, so any new vendor would have reported
      // OpenCode's skills as its own — a silent wrong answer rather than a
      // visible gap.
      const unhandled: never = vendor
      throw new Error(`no skills scanner registered for vendor: ${String(unhandled)}`)
    },
    previewMemory: discoverMemory,
  }
}

export async function previewMigrationArtifact(
  vendor: MigrationVendor,
  artifact: MigrationArtifact,
  context?: { cwd?: string },
  deps?: ArtifactPreviewDeps
): Promise<PreviewArtifactOutput> {
  const resolved = deps ?? (await defaultPreviewDeps())
  if (artifact === "settings")
    return { items: await resolved.previewSettings(vendor), warnings: [] }
  if (artifact === "commands") {
    const preview = await resolved.previewCommands(vendor)
    return { items: preview.drafts, warnings: preview.warnings }
  }
  if (artifact === "sessions")
    return { items: await resolved.previewSessions(vendor), warnings: [] }
  if (artifact === "mcp") return resolved.previewMcp(vendor, context?.cwd)
  if (artifact === "subagents") {
    const preview = await resolved.previewSubagents(vendor)
    return { items: preview.drafts, warnings: preview.warnings }
  }
  if (artifact === "skills") return { items: await resolved.previewSkills(vendor), warnings: [] }
  return { items: await resolved.previewMemory(vendor, context?.cwd), warnings: [] }
}

function normalizeMcpResult(value: {
  created?: number
  updated?: number
  skipped?: number
  errored?: Array<{ error: string }>
  imported?: number
  warnings?: string[]
}): MigrationArtifactResult {
  return {
    imported: value.imported ?? value.created ?? 0,
    updated: value.updated ?? 0,
    skipped: value.skipped ?? 0,
    warnings: value.warnings ?? value.errored?.map((item) => item.error) ?? [],
  }
}

async function defaultApplyDeps(): Promise<ArtifactApplyDeps> {
  return {
    applySettings: async (items, strategy) => {
      const { applySettingsImport } = await import("@/lib/settings-import/apply")
      const drafts = items as import("@/lib/settings-import").SettingsImportDraft[]
      const result = await applySettingsImport(
        drafts,
        drafts.map((draft) => draft.id),
        strategy
      )
      return { imported: result.applied, skipped: result.skipped, warnings: result.warnings }
    },
    applyCommands: async (items, strategy) => {
      const { applyCommandsImport } = await import("@/lib/commands-import/apply")
      const result = await applyCommandsImport(
        items as import("@/lib/commands-import").CommandImportDraft[],
        strategy
      )
      return {
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        warnings: [...result.warnings, ...result.failed.map((failure) => failure.error)],
      }
    },
    applySessions: async (items, plan, signal) => {
      const sessions = await import("@/lib/session-import")
      const refs = (items as SessionSummary[]).map((summary) => summary.ref)
      const result = await sessions.importSessions(
        refs,
        await sessions.resolveScanInput(),
        plan.projectId,
        { signal }
      )
      return { imported: result.sessions, warnings: [] }
    },
    applyMcp: async (vendor, strategy) =>
      normalizeMcpResult(
        await (await import("@/lib/claude/sync")).importFromAgent(vendor, strategy)
      ),
    applyProjectMcp: async (cwd, strategy) =>
      normalizeMcpResult(
        await (await import("@/lib/claude/sync")).importFromProjectMcp(cwd, strategy)
      ),
    applySubagents: async (items, strategy) => {
      const { applySubagentImport } = await import("@/lib/claude/subagent-importers/apply")
      const result = await applySubagentImport({
        drafts: items as SubagentImportDraft[],
        target: "subagent-template",
        strategy,
      })
      return {
        imported: result.imported,
        updated: result.overwritten,
        skipped: result.skipped,
        warnings: result.failed.map((failure) => failure.error),
      }
    },
    applySkills: async (items, strategy) => {
      const [{ parseSkillMarkdown }, { bulkImportSkills }] = await Promise.all([
        import("@/lib/claude/skills-io"),
        import("@/lib/db/skills"),
      ])
      const drafts = (items as NativeSkill[]).map((skill) => ({
        ...parseSkillMarkdown(skill.content, { fallbackName: skill.dirName }).draft,
        source: "imported" as const,
      }))
      const result = await bulkImportSkills(drafts, strategy)
      return {
        imported: result.created,
        updated: result.updated,
        skipped: result.skipped,
        warnings: result.errored.map((failure) => failure.error),
      }
    },
  }
}

export async function applyMigrationArtifact(
  vendor: MigrationVendor,
  artifact: MigrationArtifact,
  cell: MigrationPreviewCell,
  plan: MigrationPlan,
  signal?: AbortSignal,
  deps?: ArtifactApplyDeps
): Promise<MigrationArtifactResult> {
  const resolved = deps ?? (await defaultApplyDeps())
  if (artifact === "settings") return resolved.applySettings(cell.items, plan.strategy)
  if (artifact === "commands") return resolved.applyCommands(cell.items, plan.strategy)
  if (artifact === "sessions") return resolved.applySessions(cell.items, plan, signal)
  if (artifact === "subagents") return resolved.applySubagents(cell.items, plan.strategy)
  if (artifact === "skills") return resolved.applySkills(cell.items, plan.strategy)
  if (artifact === "mcp") {
    const user = await resolved.applyMcp(vendor, plan.strategy)
    if (vendor !== "claude-code" || !plan.cwd) return user
    const project = await resolved.applyProjectMcp(plan.cwd, plan.strategy)
    return {
      imported: user.imported + project.imported,
      updated: (user.updated ?? 0) + (project.updated ?? 0),
      skipped: (user.skipped ?? 0) + (project.skipped ?? 0),
      warnings: [...user.warnings, ...project.warnings],
    }
  }
  return { imported: 0, skipped: cell.count, warnings: cell.warnings }
}
