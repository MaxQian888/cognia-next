import { getDb } from "./schema"

export interface BrowserProfileRow {
  id: string
  workspaceId: string
  name: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  selected?: boolean
}

export interface BrowserDomainGrantRow {
  id: string
  workspaceId: string
  domain: string
  createdAt: number
  updatedAt: number
}

function profileId(): string {
  return crypto.randomUUID()
}

export function normalizeBrowserGrantDomain(input: string): string {
  const candidate = input.trim().toLowerCase()
  const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`)
  const domain = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (
    !domain ||
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain) ||
    domain.includes(":")
  ) {
    throw new Error("Only public DNS hostnames can be granted")
  }
  return domain
}

export async function createBrowserProfile(
  workspaceId: string,
  name: string,
  now = Date.now()
): Promise<BrowserProfileRow> {
  const trimmedName = name.trim()
  if (!workspaceId || !trimmedName) throw new Error("workspaceId and profile name are required")
  const row: BrowserProfileRow = {
    id: profileId(),
    workspaceId,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().browserProfiles.add(row)
  return row
}

export function listBrowserProfiles(workspaceId: string): Promise<BrowserProfileRow[]> {
  return getDb().browserProfiles.where("workspaceId").equals(workspaceId).sortBy("updatedAt")
}

export async function touchBrowserProfile(profileIdValue: string, now = Date.now()): Promise<void> {
  const updated = await getDb().browserProfiles.update(profileIdValue, {
    lastUsedAt: now,
    updatedAt: now,
  })
  if (!updated) throw new Error("Browser profile not found")
}

export async function deleteBrowserProfile(profileIdValue: string): Promise<void> {
  await getDb().browserProfiles.delete(profileIdValue)
}

export async function selectBrowserProfile(
  workspaceId: string,
  profileIdValue: string | null,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.browserProfiles, async () => {
    const profiles = await db.browserProfiles.where("workspaceId").equals(workspaceId).toArray()
    if (profileIdValue && !profiles.some((profile) => profile.id === profileIdValue)) {
      throw new Error("Browser profile not found in workspace")
    }
    await Promise.all(
      profiles.map((profile) =>
        db.browserProfiles.update(profile.id, {
          selected: profile.id === profileIdValue,
          updatedAt: profile.id === profileIdValue ? now : profile.updatedAt,
        })
      )
    )
  })
}

export async function grantBrowserDomain(
  workspaceId: string,
  input: string,
  now = Date.now()
): Promise<BrowserDomainGrantRow> {
  const domain = normalizeBrowserGrantDomain(input)
  const id = `${workspaceId}\u0000${domain}`
  const existing = await getDb().browserDomainGrants.get(id)
  const row: BrowserDomainGrantRow = {
    id,
    workspaceId,
    domain,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await getDb().browserDomainGrants.put(row)
  return row
}

export function listBrowserDomainGrants(workspaceId: string): Promise<BrowserDomainGrantRow[]> {
  return getDb().browserDomainGrants.where("workspaceId").equals(workspaceId).sortBy("domain")
}

export async function revokeBrowserDomain(workspaceId: string, input: string): Promise<void> {
  const domain = normalizeBrowserGrantDomain(input)
  await getDb().browserDomainGrants.delete(`${workspaceId}\u0000${domain}`)
}
