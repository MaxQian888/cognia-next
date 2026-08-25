/**
 * The person behind an external subject — ADR-0149 §3, Batch 5.
 *
 * # Why this exists
 *
 * Before this module the only way to become a `User` was to sign in through
 * Logto. Everybody who reached Cognia through IM was represented by their
 * platform id and nothing else, which is why `feishuPrincipals.cogniaUserId`
 * had to be filled with a LocalProfile id: the field named a person, and
 * there was no person to name.
 *
 * `resolveExternalPerson` is the other door. It turns "a subject at a provider"
 * into a `User`, minting one the first time and finding the same one every
 * time after, so an IM sender is a person the rest of the system can talk
 * about.
 *
 * # Tenanted subjects are written; untenanted ones are only searched
 *
 * `externalIdentityId` puts the tenant in the primary key, because two Logto
 * deployments can mint the same `sub` for two different humans. A caller that
 * holds a subject but not its tenant therefore cannot WRITE a row — the id it
 * would compute is not the id the tenant-aware writer uses, so the row would
 * be a duplicate nobody ever finds again.
 *
 * So a subject with no tenant is a lookup key only. That is exactly the shape
 * the IM plane needs: a Lark principal knows its own `tenantKey`/`appId`, and
 * knows the person's `logtoSubject` without knowing which Logto issued it.
 *
 * # What it will not do
 *
 * It never re-points a subject that already belongs to somebody else. Linking
 * is skipped for any subject already claimed, because silently moving one is
 * how one human's conversations get attributed to another — and re-pointing is
 * a decision an operator makes explicitly, through the principal rebind.
 */

import {
  findUserIdByExternalIdentity,
  findUserIdByProviderSubject,
  linkExternalIdentity,
  upsertUser,
} from "@/lib/db/identity"
import { generateUserId, type ExternalIdentityProvider, type User } from "@/types/identity"

export interface ExternalSubject {
  provider: ExternalIdentityProvider
  subject: string
  /**
   * The provider-side tenant. Present means "search here and file here";
   * absent means "search every tenant, and file nothing" — see the header.
   */
  tenant?: string
}

export type ExternalPersonErrorCode = "no-linkable-subject" | "no-subjects"

export class ExternalPersonError extends Error {
  readonly code: ExternalPersonErrorCode

  constructor(code: ExternalPersonErrorCode, message: string) {
    super(message)
    this.name = "ExternalPersonError"
    this.code = code
  }
}

export interface ResolveExternalPersonInput {
  /**
   * Candidate subjects, STRONGEST FIRST. The first one that already names a
   * person wins, so put the key that survives an app change (a Lark
   * `union_id`, a Logto `sub`) ahead of the one that does not (`open_id`).
   */
  subjects: readonly ExternalSubject[]
  /**
   * The label a newly minted person gets. Required rather than defaulted: a
   * caller that supplies nothing would put the raw subject on screen, and this
   * module's callers deliberately hash theirs instead.
   */
  displayName: string
  now?: number
}

export interface ExternalPersonResolution {
  userId: string
  /** True when this call minted the person rather than finding them. */
  created: boolean
  /** The subject that identified an existing person, when one did. */
  matched?: ExternalSubject
  /** Subjects newly pointed at this person by this call. */
  linked: ExternalSubject[]
}

function subjectKey(subject: ExternalSubject): string {
  return `${subject.provider}:${subject.tenant ?? ""}:${subject.subject}`
}

/** Which person does this subject already name? */
async function lookup(subject: ExternalSubject): Promise<string | undefined> {
  return subject.tenant
    ? findUserIdByExternalIdentity(subject.provider, subject.subject, subject.tenant)
    : findUserIdByProviderSubject(subject.provider, subject.subject)
}

/**
 * Find the person these subjects describe, without creating one.
 *
 * Returns the first match in the order given, so the caller's ranking is the
 * tie-break rather than whatever the table happens to return.
 */
export async function findExternalPerson(
  subjects: readonly ExternalSubject[]
): Promise<{ userId: string; matched: ExternalSubject } | undefined> {
  for (const subject of subjects) {
    const userId = await lookup(subject)
    if (userId) return { userId, matched: subject }
  }
  return undefined
}

/**
 * Find or mint the person these subjects describe, and file every tenanted
 * subject that is still unclaimed under them.
 *
 * Idempotent: a second call with the same subjects finds the person the first
 * one minted, links nothing, and leaves `linkedAt` where it was.
 */
export async function resolveExternalPerson(
  input: ResolveExternalPersonInput
): Promise<ExternalPersonResolution> {
  if (input.subjects.length === 0) {
    throw new ExternalPersonError(
      "no-subjects",
      "resolveExternalPerson: no candidate subjects were supplied."
    )
  }

  const linkable = input.subjects.filter((subject) => Boolean(subject.tenant))
  if (linkable.length === 0) {
    throw new ExternalPersonError(
      "no-linkable-subject",
      "resolveExternalPerson: every candidate subject is untenanted, so the person " +
        "could be found but never filed. Supply at least one subject with a tenant."
    )
  }

  const now = input.now ?? Date.now()
  const found = await findExternalPerson(input.subjects)

  let userId: string
  let created: boolean
  if (found) {
    userId = found.userId
    created = false
  } else {
    userId = generateUserId()
    const user: User = {
      id: userId,
      displayName: input.displayName,
      createdAt: now,
      updatedAt: now,
    }
    await upsertUser(user)
    created = true
  }

  const linked: ExternalSubject[] = []
  for (const subject of linkable) {
    if (found && subjectKey(subject) === subjectKey(found.matched)) continue
    // Claimed by somebody — possibly this same person, possibly not. Either
    // way there is nothing to write: an existing row already answers the
    // question, and overwriting one that answers it differently is a
    // re-attribution no automatic path is allowed to make.
    if (await lookup(subject)) continue
    await linkExternalIdentity({
      userId,
      provider: subject.provider,
      subject: subject.subject,
      ...(subject.tenant ? { tenant: subject.tenant } : {}),
      label: input.displayName,
      now,
    })
    linked.push(subject)
  }

  return { userId, created, ...(found ? { matched: found.matched } : {}), linked }
}
