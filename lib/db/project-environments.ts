import type {
  ProjectEnvironment,
  ProjectEnvironmentPolicy,
  ProjectEnvironmentVersion,
} from "@/types/project-environment"
import { getDb } from "./schema"

/**
 * Fill in the collections a stored row can be missing.
 *
 * Rows are read straight off Dexie with no schema validation, and the type
 * itself records that legacy definitions omit fields ("Legacy desktop
 * definitions omit this field" on `policy`). Every reader then indexed into
 * `variables` / `keyringReferences` / `actions` as if they were always there —
 * `Object.keys(undefined)` and `undefined.map` both throw, and in the settings
 * panel that threw during render and blanked the whole page.
 *
 * Hydrating on the way out means one fix covers the panel, the executor, the
 * resolver, and `assertEnvironmentBoundary` on the next save.
 */
export function hydrateProjectEnvironment(environment: ProjectEnvironment): ProjectEnvironment {
  return {
    ...environment,
    setupScript: environment.setupScript ?? { default: "" },
    actions: environment.actions ?? [],
    variables: environment.variables ?? {},
    keyringReferences: environment.keyringReferences ?? [],
  }
}

function assertEnvironmentBoundary(environment: ProjectEnvironment): void {
  if (!environment.id || !environment.projectId || !environment.name.trim()) {
    throw new Error("Project environment requires id, projectId, and name")
  }

  const plainVariables = new Set(Object.keys(environment.variables))
  const keyringVariables = new Set<string>()
  for (const reference of environment.keyringReferences) {
    if (!reference.variable || !reference.keyringRef) {
      throw new Error("Project environment keyring references must be opaque non-empty ids")
    }
    if (plainVariables.has(reference.variable)) {
      throw new Error(
        `Environment variable ${reference.variable} cannot be plain and keyring-backed`
      )
    }
    if (keyringVariables.has(reference.variable)) {
      throw new Error(`Environment variable ${reference.variable} has duplicate keyring references`)
    }
    keyringVariables.add(reference.variable)
  }
}

export async function putProjectEnvironment(environment: ProjectEnvironment): Promise<void> {
  assertEnvironmentBoundary(environment)
  await getDb().projectEnvironments.put(environment)
}

export async function getProjectEnvironment(id: string): Promise<ProjectEnvironment | undefined> {
  const row = await getDb().projectEnvironments.get(id)
  return row ? hydrateProjectEnvironment(row) : undefined
}

export async function listProjectEnvironments(projectId: string): Promise<ProjectEnvironment[]> {
  const rows = await getDb().projectEnvironments.where("projectId").equals(projectId).toArray()
  return rows
    .map(hydrateProjectEnvironment)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

export async function deleteProjectEnvironment(id: string): Promise<void> {
  await getDb().projectEnvironments.delete(id)
}

export async function updateProjectEnvironmentInitialization(
  id: string,
  lastInitialization: ProjectEnvironment["lastInitialization"],
  updatedAt: number
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.projectEnvironments, async () => {
    const environment = await db.projectEnvironments.get(id)
    if (!environment) return false
    const initializationHistory = lastInitialization
      ? [...(environment.initializationHistory ?? []), structuredClone(lastInitialization)].slice(
          -100
        )
      : (environment.initializationHistory ?? [])
    return (
      (await db.projectEnvironments.update(id, {
        lastInitialization,
        initializationHistory,
        updatedAt,
      })) > 0
    )
  })
}

export async function createProjectEnvironmentVersion(
  environment: ProjectEnvironment,
  policy: ProjectEnvironmentPolicy,
  createdAt = Date.now(),
  idempotencyKey?: string
): Promise<ProjectEnvironmentVersion> {
  assertEnvironmentBoundary(environment)
  const db = getDb()
  return db.transaction("rw", db.projectEnvironmentVersions, async () => {
    const materializedId = idempotencyKey
      ? `${environment.id}:materialized:${idempotencyKey}`
      : undefined
    if (materializedId) {
      const existing = await db.projectEnvironmentVersions.get(materializedId)
      if (existing) return existing
    }
    const last = await db.projectEnvironmentVersions
      .where("[environmentId+version]")
      .between([environment.id, -Infinity], [environment.id, Infinity])
      .last()
    const version = (last?.version ?? 0) + 1
    const row: ProjectEnvironmentVersion = {
      id: materializedId ?? `${environment.id}:v${version}`,
      environmentId: environment.id,
      projectId: environment.projectId,
      version,
      name: environment.name,
      setupScript: structuredClone(environment.setupScript),
      actions: structuredClone(environment.actions),
      variables: structuredClone(environment.variables),
      keyringReferences: structuredClone(environment.keyringReferences),
      policy: structuredClone(policy),
      createdAt,
    }
    await db.projectEnvironmentVersions.add(row)
    return row
  })
}

export async function getProjectEnvironmentVersion(
  id: string
): Promise<ProjectEnvironmentVersion | undefined> {
  return getDb().projectEnvironmentVersions.get(id)
}

export async function listProjectEnvironmentVersions(
  environmentId: string
): Promise<ProjectEnvironmentVersion[]> {
  const rows = await getDb()
    .projectEnvironmentVersions.where("environmentId")
    .equals(environmentId)
    .toArray()
  return rows.sort((a, b) => b.version - a.version)
}

export function compareProjectEnvironmentVersions(
  left: ProjectEnvironmentVersion,
  right: ProjectEnvironmentVersion
): Array<{ field: string; before: unknown; after: unknown }> {
  if (left.environmentId !== right.environmentId) {
    throw new Error("Project environment versions must belong to the same environment")
  }
  const fields = [
    "name",
    "setupScript",
    "actions",
    "variables",
    "keyringReferences",
    "policy",
  ] as const
  return fields.flatMap((field) =>
    JSON.stringify(left[field]) === JSON.stringify(right[field])
      ? []
      : [{ field, before: left[field], after: right[field] }]
  )
}

/** Rollback is itself a new immutable version; historical rows never mutate. */
export async function rollbackProjectEnvironmentVersion(
  targetVersionId: string,
  createdAt = Date.now()
): Promise<ProjectEnvironmentVersion> {
  const target = await getProjectEnvironmentVersion(targetVersionId)
  if (!target) throw new Error(`Unknown project environment version: ${targetVersionId}`)
  return createProjectEnvironmentVersion(
    {
      id: target.environmentId,
      projectId: target.projectId,
      name: target.name,
      isEnabled: true,
      setupScript: structuredClone(target.setupScript),
      actions: structuredClone(target.actions),
      variables: structuredClone(target.variables),
      keyringReferences: structuredClone(target.keyringReferences),
      createdAt: target.createdAt,
      updatedAt: createdAt,
    },
    structuredClone(target.policy),
    createdAt
  )
}
