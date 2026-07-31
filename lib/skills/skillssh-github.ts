// Direct-install input parsing for the "Install from URL" dialog. Accepts:
//
//   https://skills.sh/{owner}/{repo}/{slug}   (skill page URL)
//   https://www.skills.sh/{owner}/{repo}/{slug}
//   owner/repo/slug                            (full triple)
//   owner/repo                                 (slug assumed = repo name)
//
// Resolution goes through the anonymous skills.sh download endpoint via
// `fetchSkillsShDetail`, so a GitHub repo that publishes skills works
// without any GitHub API descent. A repo-only ref that 404s produces a
// guidance error telling the user to supply the full triple.

import type { MarketplaceItem } from "./marketplace-types"
import { fetchSkillsShDetail, type SkillsShDetail } from "./marketplace-skillssh"
import { SkillsHttpError } from "./skillssh-http"

export type SkillsShInputRef =
  | { kind: "full"; owner: string; repo: string; slug: string }
  | { kind: "repo-only"; owner: string; repo: string }
  | { kind: "invalid" }

const SEGMENT = /^[A-Za-z0-9_.-]+$/

function isSegment(s: string): boolean {
  return SEGMENT.test(s)
}

/** Parse user input into a skills.sh reference. Never throws. */
export function parseSkillsShInput(input: string): SkillsShInputRef {
  let value = input.trim()
  if (!value) return { kind: "invalid" }
  // URL forms — skills.sh page links (and github.com repo links, whose
  // owner/repo path shape matches the repo-only form).
  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return { kind: "invalid" }
    }
    const host = url.hostname.toLowerCase()
    if (host !== "skills.sh" && host !== "www.skills.sh" && host !== "github.com") {
      return { kind: "invalid" }
    }
    value = url.pathname.replace(/^\/+|\/+$/g, "")
  }
  const parts = value.split("/").filter(Boolean)
  if (!parts.every(isSegment)) return { kind: "invalid" }
  if (parts.length === 3) {
    return { kind: "full", owner: parts[0], repo: parts[1], slug: parts[2] }
  }
  if (parts.length === 2) {
    return { kind: "repo-only", owner: parts[0], repo: parts[1] }
  }
  return { kind: "invalid" }
}

/** Thrown when a repo-only ref has no snapshot under slug = repo name. */
export class SkillsShSlugRequiredError extends Error {
  constructor(owner: string, repo: string) {
    super(
      `No skill found at ${owner}/${repo}/${repo} — append the skill slug (owner/repo/slug) or paste the skills.sh page URL`
    )
    this.name = "SkillsShSlugRequiredError"
  }
}

export interface ResolvedSkillsShRef {
  item: MarketplaceItem
  detail: SkillsShDetail
}

/**
 * Resolve a parsed reference to an installable MarketplaceItem (and its
 * already-fetched snapshot, so the caller doesn't re-download). For
 * repo-only refs the slug defaults to the repo name — the dominant
 * single-skill-repo convention; a 404 surfaces as guidance instead.
 */
export async function resolveSkillsShRef(
  ref: Exclude<SkillsShInputRef, { kind: "invalid" }>
): Promise<ResolvedSkillsShRef> {
  const slug = ref.kind === "full" ? ref.slug : ref.repo
  const triple = `${ref.owner}/${ref.repo}/${slug}`
  const item: MarketplaceItem = {
    id: `skillssh:${triple}`,
    source: "skillssh",
    sourceId: triple,
    name: slug,
    repository: `${ref.owner}/${ref.repo}`,
    category: "custom",
  }
  try {
    const detail = await fetchSkillsShDetail(item)
    return { item, detail }
  } catch (err) {
    if (ref.kind === "repo-only" && err instanceof SkillsHttpError && err.status === 404) {
      throw new SkillsShSlugRequiredError(ref.owner, ref.repo)
    }
    throw err
  }
}
