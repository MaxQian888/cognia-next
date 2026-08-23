import fs from "node:fs"
import path from "node:path"

import {
  buildAgentDefinition,
  isAgentDefinitionV1,
  validateAgentDefinitionInput,
  type AgentDefinitionChanges,
  type AgentDefinitionInput,
  type AgentDefinitionV1,
} from "@/packages/agent/src/agent-definition"

export interface AgentDefinitionSummary {
  agentId: string
  name: string
  latestVersion: number
  definitionDigest: string
  createdAt: string
  archivedAt?: string
}

export class AgentDefinitionStoreError extends Error {
  constructor(
    readonly code:
      "not_found" | "version_conflict" | "invalid_definition" | "already_exists" | "archived",
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message)
    this.name = "AgentDefinitionStoreError"
  }
}

export interface AgentDefinitionStore {
  create(input: AgentDefinitionInput): AgentDefinitionV1
  get(agentId: string, version?: number): AgentDefinitionV1
  list(options?: { includeArchived?: boolean }): AgentDefinitionSummary[]
  versions(agentId: string): number[]
  update(
    agentId: string,
    expectedVersion: number,
    changes: AgentDefinitionChanges
  ): AgentDefinitionV1
  archive(agentId: string): AgentDefinitionSummary
  restore(agentId: string): AgentDefinitionSummary
}

interface AgentState {
  archivedAt?: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i

/**
 * Host-persisted agent definitions.
 *
 * Two properties do the work here:
 *
 * **Versions are immutable files.** `v3.json` is written once with an exclusive
 * create, so two processes racing the same compare-and-swap cannot both win —
 * the loser gets EEXIST and is reported as a version conflict rather than
 * silently overwriting. Nothing ever rewrites an existing version, which is why
 * a session that froze v1 can still read v1 after the agent has moved to v9.
 *
 * **Archive is a separate mutable file.** Marking an agent archived cannot mean
 * editing its versions, so the flag lives in `state.json` and is projected onto
 * definitions on read. Archived versions stay readable forever, because
 * sessions reference them.
 *
 * Everything is written 0600 into a 0700 directory through a temp-file rename,
 * so a crash mid-write leaves either the old file or the new one.
 */
export function createAgentDefinitionStore(options: {
  home: string
  now?: () => number
  mintAgentId?: () => string
}): AgentDefinitionStore {
  const root = path.join(options.home, "agents")
  const now = options.now ?? Date.now
  const timestamp = () => new Date(now()).toISOString()

  function agentDir(agentId: string): string {
    if (!ID_PATTERN.test(agentId)) {
      throw new AgentDefinitionStoreError("invalid_definition", `invalid agentId ${agentId}`)
    }
    return path.join(root, agentId)
  }

  function writeAtomic(target: string, contents: string, exclusive: boolean): void {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    if (exclusive && fs.existsSync(target)) {
      throw new AgentDefinitionStoreError("already_exists", `${target} already exists`)
    }
    const temporary = `${target}.${process.pid}.${now()}.tmp`
    // `wx` on the temp file, then rename: the rename is the commit point, so a
    // reader never observes a partially written definition.
    const handle = fs.openSync(temporary, "wx", 0o600)
    try {
      fs.writeSync(handle, contents)
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    if (exclusive && fs.existsSync(target)) {
      fs.rmSync(temporary, { force: true })
      throw new AgentDefinitionStoreError("already_exists", `${target} already exists`)
    }
    fs.renameSync(temporary, target)
  }

  function readState(agentId: string): AgentState {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(agentDir(agentId), "state.json"), "utf8")
      ) as AgentState
      return typeof parsed?.archivedAt === "string" ? { archivedAt: parsed.archivedAt } : {}
    } catch {
      return {}
    }
  }

  function writeState(agentId: string, state: AgentState): void {
    writeAtomic(path.join(agentDir(agentId), "state.json"), `${JSON.stringify(state)}\n`, false)
  }

  function versionFile(agentId: string, version: number): string {
    return path.join(agentDir(agentId), `v${version}.json`)
  }

  function listVersions(agentId: string): number[] {
    let entries: string[]
    try {
      entries = fs.readdirSync(agentDir(agentId))
    } catch {
      return []
    }
    return entries
      .map((entry) => /^v(\d+)\.json$/.exec(entry))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right)
  }

  function readVersion(agentId: string, version: number): AgentDefinitionV1 {
    let raw: string
    try {
      raw = fs.readFileSync(versionFile(agentId, version), "utf8")
    } catch {
      throw new AgentDefinitionStoreError(
        "not_found",
        `agent ${agentId} has no version ${version}`,
        { agentId, version }
      )
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isAgentDefinitionV1(parsed)) {
      throw new AgentDefinitionStoreError(
        "invalid_definition",
        `stored definition ${agentId}@${version} failed validation`,
        { agentId, version }
      )
    }
    const state = readState(agentId)
    return state.archivedAt ? { ...parsed, archivedAt: state.archivedAt } : parsed
  }

  function assertValid(input: AgentDefinitionInput | AgentDefinitionChanges): void {
    const errors = validateAgentDefinitionInput(input)
    if (errors.length > 0) {
      throw new AgentDefinitionStoreError("invalid_definition", errors.join("; "), { errors })
    }
  }

  function summarise(agentId: string): AgentDefinitionSummary {
    const versions = listVersions(agentId)
    const latest = versions.at(-1)
    if (latest === undefined) {
      throw new AgentDefinitionStoreError("not_found", `unknown agent ${agentId}`, { agentId })
    }
    const definition = readVersion(agentId, latest)
    const first = readVersion(agentId, versions[0]!)
    return {
      agentId,
      name: definition.name,
      latestVersion: latest,
      definitionDigest: definition.definitionDigest,
      createdAt: first.createdAt,
      ...(definition.archivedAt ? { archivedAt: definition.archivedAt } : {}),
    }
  }

  function mintAgentId(name: string): string {
    if (options.mintAgentId) return options.mintAgentId()
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
    const base = slug.length > 0 ? slug : "agent"
    if (listVersions(base).length === 0) return base
    for (let suffix = 2; suffix < 1_000; suffix += 1) {
      const candidate = `${base}-${suffix}`
      if (listVersions(candidate).length === 0) return candidate
    }
    throw new AgentDefinitionStoreError("already_exists", `cannot mint an id for ${name}`)
  }

  return {
    create(input) {
      assertValid(input)
      const agentId = input.agentId ?? mintAgentId(input.name)
      if (listVersions(agentId).length > 0) {
        throw new AgentDefinitionStoreError(
          "already_exists",
          `agent ${agentId} already exists; update it with expectedVersion instead`,
          { agentId }
        )
      }
      const definition = buildAgentDefinition(input, {
        agentId,
        version: 1,
        createdAt: timestamp(),
      })
      writeAtomic(versionFile(agentId, 1), `${JSON.stringify(definition, null, 2)}\n`, true)
      return definition
    },

    get(agentId, version) {
      const versions = listVersions(agentId)
      if (versions.length === 0) {
        throw new AgentDefinitionStoreError("not_found", `unknown agent ${agentId}`, { agentId })
      }
      return readVersion(agentId, version ?? versions.at(-1)!)
    },

    list(listOptions = {}) {
      let entries: string[]
      try {
        entries = fs.readdirSync(root)
      } catch {
        return []
      }
      const out: AgentDefinitionSummary[] = []
      for (const entry of entries) {
        if (!ID_PATTERN.test(entry)) continue
        if (listVersions(entry).length === 0) continue
        const summary = summarise(entry)
        if (summary.archivedAt && listOptions.includeArchived !== true) continue
        out.push(summary)
      }
      return out.sort((left, right) => left.agentId.localeCompare(right.agentId))
    },

    versions(agentId) {
      const versions = listVersions(agentId)
      if (versions.length === 0) {
        throw new AgentDefinitionStoreError("not_found", `unknown agent ${agentId}`, { agentId })
      }
      return versions
    },

    update(agentId, expectedVersion, changes) {
      assertValid(changes)
      const versions = listVersions(agentId)
      const latest = versions.at(-1)
      if (latest === undefined) {
        throw new AgentDefinitionStoreError("not_found", `unknown agent ${agentId}`, { agentId })
      }
      if (readState(agentId).archivedAt) {
        throw new AgentDefinitionStoreError(
          "archived",
          `agent ${agentId} is archived; restore it before updating`,
          { agentId }
        )
      }
      if (latest !== expectedVersion) {
        throw new AgentDefinitionStoreError(
          "version_conflict",
          `agent ${agentId} is at version ${latest}, not ${expectedVersion}`,
          { agentId, expectedVersion, actualVersion: latest }
        )
      }
      const next = buildAgentDefinition(changes, {
        agentId,
        version: latest + 1,
        createdAt: timestamp(),
      })
      try {
        writeAtomic(versionFile(agentId, next.version), `${JSON.stringify(next, null, 2)}\n`, true)
      } catch (error) {
        // Another writer committed the same version between our read and our
        // write. That is the conflict this CAS exists to catch.
        if (error instanceof AgentDefinitionStoreError && error.code === "already_exists") {
          throw new AgentDefinitionStoreError(
            "version_conflict",
            `agent ${agentId} version ${next.version} was written concurrently`,
            { agentId, expectedVersion, actualVersion: next.version }
          )
        }
        throw error
      }
      return next
    },

    archive(agentId) {
      const summary = summarise(agentId)
      if (summary.archivedAt) return summary
      writeState(agentId, { archivedAt: timestamp() })
      return summarise(agentId)
    },

    restore(agentId) {
      const summary = summarise(agentId)
      if (!summary.archivedAt) return summary
      writeState(agentId, {})
      return summarise(agentId)
    },
  }
}
