/** Portable authored graphs shared by v3/v4 writers and the existing importer. */
import type { Table } from "dexie"
import type { CogniaDB } from "@/lib/db/schema"
import type { BackupPayloadV3, ExportOptions, ImportOptions } from "./types"
import { deepStripSecrets } from "@/lib/settings/profile-transfer"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { ensureIssueNumberAbove } from "@/lib/db/issue-counters"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import type { BackupStreamSection } from "./stream-format"
import type { ChatSession } from "@cognia/agent-config-types"
import { createPagedTablePageIterator } from "./paged-table-reader"

export const AUTHORED_CONTENT_TABLES = [
  "projects",
  "sessionFolders",
  "workflowFolders",
  "knowledgeBases",
  "knowledgeBaseSources",
  "knowledgeNotes",
  "labels",
  "issueProjects",
  "issueCycles",
  "issues",
  "issueEvents",
  "agentTeams",
  "agentTeammates",
  "agentTeamTasks",
  "workflows",
  "workflowVersions",
] as const

export type AuthoredContentTable = (typeof AUTHORED_CONTENT_TABLES)[number]
export type AuthoredContentRow = Record<string, unknown> & { id: string }
export type AuthoredContentPayload = Partial<Record<AuthoredContentTable, AuthoredContentRow[]>>
export type AuthoredIdMaps = Partial<Record<AuthoredContentTable | "sessions", Map<string, string>>>

/** Keep conversation content while detaching references to parents absent from this export. */
export function portableSessionReferences<T extends ChatSession>(
  session: T,
  membership: AuthoredIdMaps
): T {
  const row = { ...session }
  for (const [field, parent] of [
    ["projectId", "projects"],
    ["folderId", "sessionFolders"],
    ["squadId", "agentTeams"],
    ["issueId", "issues"],
  ] as const) {
    const id = row[field]
    if (id && !membership[parent]?.has(id)) delete row[field]
  }
  return row
}

const RELATIONS: Record<string, AuthoredContentTable | "sessions"> = {
  sessionId: "sessions",
  sessionIds: "sessions",
  squadId: "agentTeams",
  projectId: "projects",
  folderId: "sessionFolders",
  knowledgeBaseId: "knowledgeBases",
  knowledgeBaseIds: "knowledgeBases",
  issueProjectId: "issueProjects",
  cycleId: "issueCycles",
  issueId: "issues",
  blockedBy: "issues",
  labelIds: "labels",
  workflowId: "workflows",
  leadId: "agentTeammates",
  teammateIds: "agentTeammates",
  taskIds: "agentTeamTasks",
  assignedTo: "agentTeammates",
  completedTaskIds: "agentTeamTasks",
  dependencies: "agentTeamTasks",
}

const PARENTS: Partial<Record<AuthoredContentTable, [string, AuthoredContentTable]>> = {
  sessionFolders: ["projectId", "projects"],
  knowledgeBaseSources: ["knowledgeBaseId", "knowledgeBases"],
  issueProjects: ["projectId", "projects"],
  issueCycles: ["projectId", "projects"],
  issues: ["issueProjectId", "issueProjects"],
  issueEvents: ["issueId", "issues"],
  agentTeammates: ["teamId", "agentTeams"],
  agentTeamTasks: ["teamId", "agentTeams"],
  workflowVersions: ["workflowId", "workflows"],
}

export function authoredContentTable(
  db: CogniaDB,
  name: AuthoredContentTable
): Table<AuthoredContentRow, string> {
  return db.table(name)
}

/** Serialize dates before canonical hashing; device consent and runtime ownership never travel. */
function portableRow(
  name: AuthoredContentTable,
  value: AuthoredContentRow,
  includeSecrets: boolean
): AuthoredContentRow {
  const serialized = JSON.parse(JSON.stringify(value)) as AuthoredContentRow
  const row = (includeSecrets ? serialized : deepStripSecrets(serialized)) as AuthoredContentRow
  if (name === "projects") {
    delete row.workspaceProvisioning
    delete row.defaultEnvironmentId
    delete row.defaultExecutionLocation
    if (row.terminalConfig && typeof row.terminalConfig === "object") {
      delete (row.terminalConfig as Record<string, unknown>).env
    }
  }
  if (name === "workflows") delete row.published
  if (name === "agentTeams") {
    if (["executing", "planning"].includes(String(row.status))) row.status = "paused"
    for (const key of [
      "externalPickup",
      "executionReport",
      "consensusIds",
      "delegationIds",
      "parentDelegationId",
    ])
      delete row[key]
    row.messageIds = [] // Runtime messages are not part of the portable definition graph.
  }
  if (name === "agentTeammates") {
    if (["executing", "planning", "awaiting_approval"].includes(String(row.status)))
      row.status = "idle"
    delete row.currentTaskId
  }
  if (name === "agentTeamTasks") {
    if (["in_progress", "claimed"].includes(String(row.status))) row.status = "pending"
    delete row.claimedBy
    delete row.delegationRecord
  }
  if (name === "knowledgeBaseSources") {
    row.status = "pending"
    row.chunkCount = 0
    delete row.errorCode
    delete row.generationSnapshots
  }
  return row
}

/** Parent membership is captured as rows are emitted, including sessions-only organizational parents. */
export async function* exportAuthoredContent(
  db: CogniaDB,
  options: ExportOptions,
  extras: { sessions?: readonly ChatSession[]; membership?: AuthoredIdMaps; pageSize?: number } = {}
): AsyncIterable<BackupStreamSection> {
  const iterate = createPagedTablePageIterator({ pageSize: extras.pageSize ?? 500, concurrency: 1 })
  const emitted: AuthoredIdMaps = extras.membership ?? {}
  const sessionParents = new Set<string>()
  if (options.includeCoreData === false && options.includeSessions) {
    const pages = extras.sessions ? [extras.sessions] : iterate(db.sessions)
    for await (const page of pages)
      for (const row of page) {
        if (!isSessionExposed(row, "standard-export")) continue
        if (row.projectId) sessionParents.add(row.projectId)
        if (row.folderId) {
          sessionParents.add(row.folderId)
          const folder = await db.sessionFolders.get(row.folderId)
          if (folder?.projectId) sessionParents.add(folder.projectId)
        }
      }
  }
  for (const name of AUTHORED_CONTENT_TABLES) {
    if (
      options.includeCoreData === false &&
      (!options.includeSessions || (name !== "projects" && name !== "sessionFolders"))
    )
      continue
    const ids = (emitted[name] = new Map())
    let written = false
    for await (const page of iterate(authoredContentTable(db, name))) {
      const rows = page
        .filter((row) => {
          if (options.includeCoreData === false && !sessionParents.has(row.id)) return false
          if (name === "workflows" && !options.includeBuiltIns && row.isBuiltIn === true)
            return false
          const parent = PARENTS[name]
          return !parent || emitted[parent[1]]?.has(String(row[parent[0]])) === true
        })
        .map((row) => {
          ids.set(row.id, row.id)
          return portableRow(name, row, options.includeApiKey)
        })
      if (rows.length) {
        written = true
        yield { section: name, rows }
      }
    }
    if (!written) yield { section: name, rows: [] }
    if (name === "issueProjects") {
      const rows = []
      for (const id of ids.keys()) {
        const counter = await db.issueCounters.get(id)
        if (counter) rows.push(counter)
      }
      yield { section: "issueCounters", rows }
    }
  }
}

export function remapAuthoredReferences(
  value: unknown,
  maps: AuthoredIdMaps,
  table?: AuthoredContentTable
): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapAuthoredReferences(entry, maps, table))
  if (!value || typeof value !== "object" || value instanceof Date) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      let target = RELATIONS[key]
      if (key === "id" && record.kind === "team") target = "agentTeams"
      if (key === "assigneeId" && record.assigneeKind === "team") target = "agentTeams"
      if (key === "folderId" && (table === "workflows" || table === "workflowVersions"))
        target = "workflowFolders"
      if (key === "parentFolderId") target = "workflowFolders"
      if (key === "parentId" && table === "issues") target = "issues"
      if (key === "teamId" && (table === "agentTeammates" || table === "agentTeamTasks"))
        target = "agentTeams"
      const map = target ? maps[target] : undefined
      const mapped =
        map && typeof entry === "string"
          ? (map.get(entry) ?? entry)
          : map && Array.isArray(entry)
            ? entry.map((id) => (typeof id === "string" ? (map.get(id) ?? id) : id))
            : remapAuthoredReferences(entry, maps, table)
      return [key, mapped]
    })
  )
}

/** Called inside the existing full-restore transaction; the caller supplies its established row merger. */
export async function applyAuthoredContent(
  db: CogniaDB,
  payload: BackupPayloadV3,
  options: ImportOptions,
  newId: (prefix: string) => string,
  apply: (name: AuthoredContentTable, rows: AuthoredContentRow[]) => Promise<void>,
  sessionIds: Map<string, string> = new Map()
): Promise<AuthoredIdMaps> {
  const maps: AuthoredIdMaps = { sessions: sessionIds }
  for (const name of AUTHORED_CONTENT_TABLES) {
    const map = (maps[name] = new Map())
    const rows = payload[name]
    if (rows !== undefined && !Array.isArray(rows))
      throw new TypeError(`Invalid backup section: ${name}`)
    for (const row of rows ?? []) {
      if (
        !row ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        !row.id ||
        map.has(row.id)
      )
        throw new TypeError(`Invalid backup row: ${name}`)
      const existing = await authoredContentTable(db, name).get(row.id)
      const needsCopy =
        options.mergeStrategy === "duplicate" ||
        (name === "workflowVersions" && options.mergeStrategy === "overwrite")
      // A published deployment may still reference this immutable version id.
      map.set(row.id, existing && !existing.isBuiltIn && needsCopy ? newId(name) : row.id)
    }
  }
  for (const name of AUTHORED_CONTENT_TABLES) {
    const rows: AuthoredContentRow[] = []
    for (const incoming of payload[name] ?? []) {
      const row = remapAuthoredReferences(
        portableRow(name, incoming, options.includeApiKey ?? false),
        maps,
        name
      ) as AuthoredContentRow
      row.id = maps[name]!.get(incoming.id)!
      const parent = PARENTS[name]
      if (parent && !(await authoredContentTable(db, parent[1]).get(String(row[parent[0]]))))
        throw new TypeError(`Missing ${parent[1]} parent for ${name}`)
      if (name === "projects") {
        for (const key of ["createdAt", "updatedAt", "lastAccessedAt"]) {
          const date = new Date(row[key] as string | number)
          if (!Number.isFinite(date.getTime())) throw new TypeError(`Invalid project date: ${key}`)
          row[key] = date
        }
      }
      if (name === "issueProjects") {
        const conflicts = await db.issueProjects.where("key").equals(String(row.key)).first()
        if (conflicts && conflicts.id !== row.id) {
          if (options.mergeStrategy !== "duplicate")
            throw new Error("Issue project key already belongs to another project")
          do {
            row.key = newId("key")
              .replace(/[^a-z]/gi, "")
              .slice(-5)
              .toUpperCase()
          } while (await db.issueProjects.where("key").equals(String(row.key)).count())
        }
      }
      if (name === "issues") {
        const project = await db.issueProjects.get(String(row.issueProjectId))
        row.identifier = `${project!.key}-${row.number}`
      }
      if (name === "workflowVersions" && row.definition && typeof row.definition === "object") {
        row.accountId = getActiveAccountId()
        ;(row.definition as Record<string, unknown>).id = row.workflowId
        row.digest = workflowVersionDigest({
          definition: row.definition,
          interface: row.interface,
          dependencyManifest: row.dependencyManifest,
          configDefinition: row.configDefinition,
        })
      }
      rows.push(row)
    }
    await apply(name, rows)
    if (name === "issues")
      for (const row of rows)
        await ensureIssueNumberAbove(String(row.issueProjectId), Number(row.number))
  }
  for (const counter of payload.issueCounters ?? []) {
    if (
      !counter ||
      typeof counter.scopeId !== "string" ||
      !Number.isSafeInteger(counter.next) ||
      counter.next < 1
    )
      throw new TypeError("Invalid issue counter backup row")
    const scope = maps.issueProjects?.get(counter.scopeId) ?? counter.scopeId
    if (!(await db.issueProjects.get(scope)))
      throw new TypeError("Missing issue project for counter")
    await ensureIssueNumberAbove(scope, counter.next - 1)
  }
  return maps
}
