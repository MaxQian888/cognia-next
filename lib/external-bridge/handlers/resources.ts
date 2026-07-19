/**
 * MCP `resources/*` handlers.
 *
 * Resources are URI-keyed read-only data the external agent can pull on
 * demand (vs. tools, which are RPC-style). Cognia exposes three families:
 *   • `cognia://wiki/<slug>`      — full wiki article body
 *   • `cognia://skill/<id>`       — Skill row (lib/claude/types#Skill)
 *   • `cognia://character/<id>`   — Character row
 *
 * Permission gating is owned one layer up; this module just reads from
 * Dexie and shapes the responses.
 */

import { listAllWikiArticles, getWikiArticleBySlug } from "@/lib/db/wiki-articles"
import { listSkills, getSkill } from "@/lib/db/skills"
import { listCharacters, getCharacter } from "@/lib/db/characters"
import type { BridgeScope } from "@/types/wiki"
import { parseResourceUri } from "../mcp-server/resource-uri"

export { parseResourceUri } from "../mcp-server/resource-uri"

export interface ResourceDescriptor {
  uri: string
  name: string
  description?: string
  mimeType: string
  /** Permission scope required to read this resource. Used by the gate. */
  scope: BridgeScope
}

export interface ResourceContent {
  uri: string
  mimeType: string
  text: string
}

const SCHEME = "cognia://"

/**
 * Return every listable resource. Excludes resources gated behind scopes
 * the caller hasn't enabled — the gate is therefore "soft" at list time
 * (we don't enumerate things the caller can't read), and "hard" at read
 * time (we still verify on `readResource`).
 *
 * `enabledScopes` is the user's current scope whitelist; pass `[]` to
 * list nothing or the full set to list everything the user owns.
 */
export async function listResources(
  enabledScopes: readonly BridgeScope[]
): Promise<ResourceDescriptor[]> {
  const allowed = new Set(enabledScopes)
  const out: ResourceDescriptor[] = []

  if (allowed.has("wiki:cognia") || allowed.has("wiki:user-repo")) {
    const articles = await listAllWikiArticles()
    for (const a of articles) {
      const scope: BridgeScope = a.scope === "cognia-self" ? "wiki:cognia" : "wiki:user-repo"
      if (!allowed.has(scope)) continue
      out.push({
        uri: `${SCHEME}wiki/${a.slug}`,
        name: a.title,
        description: a.summary,
        mimeType: "text/markdown",
        scope,
      })
    }
  }

  if (allowed.has("runtime:skills")) {
    const skills = await listSkills()
    for (const s of skills) {
      out.push({
        uri: `${SCHEME}skill/${s.id}`,
        name: s.name,
        description: s.description,
        mimeType: "text/markdown",
        scope: "runtime:skills",
      })
    }
  }

  if (allowed.has("runtime:characters")) {
    const characters = await listCharacters()
    for (const c of characters) {
      out.push({
        uri: `${SCHEME}character/${c.id}`,
        name: c.name,
        description: c.description,
        mimeType: "application/json",
        scope: "runtime:characters",
      })
    }
  }

  return out
}

/**
 * Parse `cognia://<kind>/<id>` into its `kind` + `id` parts. Returns
 * `undefined` when the URI doesn't match the scheme (lets callers map to
 * an MCP "invalid uri" response).
 */
/**
 * Determine the permission scope a given URI requires (so the gate can
 * check before we hit Dexie). Returns `undefined` for unrecognized URIs.
 */
export async function scopeForResourceUri(uri: string): Promise<BridgeScope | undefined> {
  const parts = parseResourceUri(uri)
  if (!parts) return undefined
  switch (parts.kind) {
    case "wiki": {
      const article = await getWikiArticleBySlug(parts.id)
      if (!article) return undefined
      return article.scope === "cognia-self" ? "wiki:cognia" : "wiki:user-repo"
    }
    case "skill":
      return "runtime:skills"
    case "character":
      return "runtime:characters"
    default:
      return undefined
  }
}

/**
 * Fetch the content for a single URI. Returns `undefined` for unknown
 * URIs / missing rows; callers map that to MCP's "resource not found"
 * shape.
 */
export async function readResource(uri: string): Promise<ResourceContent | undefined> {
  const parts = parseResourceUri(uri)
  if (!parts) return undefined
  switch (parts.kind) {
    case "wiki": {
      const article = await getWikiArticleBySlug(parts.id)
      if (!article) return undefined
      return { uri, mimeType: "text/markdown", text: article.contentMd }
    }
    case "skill": {
      const skill = await getSkill(parts.id)
      if (!skill) return undefined
      // Render as a synthetic SKILL.md (YAML front-matter + body). We use
      // the existing `lib/claude/skills-io.ts:serializeSkill` so the
      // round-trip with Claude Code is lossless.
      const { serializeSkill } = await import("@/lib/claude/skills-io")
      const text = serializeSkill({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        allowedTools: skill.allowedTools,
        tags: skill.tags,
        category: skill.category,
        version: skill.version,
        author: skill.author,
        license: skill.license,
      })
      return { uri, mimeType: "text/markdown", text }
    }
    case "character": {
      const character = await getCharacter(parts.id)
      if (!character) return undefined
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(character, null, 2),
      }
    }
    default:
      return undefined
  }
}

export const __TESTING__ = { SCHEME }
