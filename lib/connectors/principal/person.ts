/**
 * The person behind a Feishu principal — ADR-0149 §3, Batch 5.
 *
 * # What changed
 *
 * `feishuPrincipals.cogniaUserId` has always been typed as a person and filled
 * with a LocalProfile id, because there was no `User` to point at. This module
 * supplies one: it maps a principal's platform ids onto the identity plane, so
 * the field finally means what it says.
 *
 * Nothing about resolution or gating moves. `resolveConnectorPrincipal` still
 * fails closed on `cogniaAccountId`, which is the LocalProfile scope this
 * runtime serves and a different question from "who is this human".
 *
 * # Which id identifies a Lark person
 *
 * Three, ranked, because they are not equally strong:
 *
 *   1. `logtoSubject` — the IdP's own answer. Present once the same human has
 *      completed web SSO, and the reason a Lark sender and a web sign-in
 *      converge on ONE `User` instead of two records nobody can merge. Filed
 *      untenanted, so it is a lookup key only: the principal row knows the
 *      subject but never the issuer the sign-in writer filed it under.
 *   2. `union_id` — stable for one human across every app of one developer,
 *      so it is filed under the tenant alone.
 *   3. `open_id` — scoped to ONE app. Filing it under `tenantKey` alone would
 *      merge two apps' different ids for one person into one row, and worse,
 *      would let one app's id answer for another's.
 *
 * # The residual this does not close
 *
 * Somebody who arrives through Lark first and signs in on the web later gets a
 * second `User`: sign-in derives its id from `(issuer, sub)` and cannot know
 * about a person minted from an `open_id`. Merging two people is an operator
 * decision, not an inference, and the operator surface for it already exists —
 * rebinding the principal to the real `usr_` re-points the Lark identity.
 */

import { linkExternalIdentity } from "@/lib/db/identity"
import {
  resolveExternalPerson,
  type ExternalPersonResolution,
  type ExternalSubject,
} from "@/lib/identity/external-person"

import { hashOpenId } from "./resolve"

/** A Lark `open_id` is only meaningful inside one app of one tenant. */
export function larkOpenIdTenant(tenantKey: string, appId: string): string {
  return `${tenantKey}/${appId}`
}

/** A `union_id` spans every app of one developer inside a tenant. */
export function larkUnionIdTenant(tenantKey: string): string {
  return tenantKey
}

export interface LarkPersonSubjectsInput {
  tenantKey: string
  appId: string
  openId: string
  unionId?: string
  /** Web-SSO linkage, when this principal has already been matched to one. */
  logtoSubject?: string
}

/** The candidate subjects for this principal, strongest first. */
export function larkPersonSubjects(input: LarkPersonSubjectsInput): ExternalSubject[] {
  const subjects: ExternalSubject[] = []
  if (input.logtoSubject) {
    subjects.push({ provider: "logto", subject: input.logtoSubject })
  }
  if (input.unionId) {
    subjects.push({
      provider: "lark",
      subject: input.unionId,
      tenant: larkUnionIdTenant(input.tenantKey),
    })
  }
  subjects.push({
    provider: "lark",
    subject: input.openId,
    tenant: larkOpenIdTenant(input.tenantKey, input.appId),
  })
  return subjects
}

/**
 * A label for a person the directory could not name.
 *
 * The hash, never the `open_id`: this module's neighbours record an open_id
 * only as `hashOpenId()`, and a display name is the one field guaranteed to
 * reach a screen, a log line and an export.
 */
export async function larkFallbackDisplayName(openId: string): Promise<string> {
  return `Lark ${await hashOpenId(openId)}`
}

export interface ResolveLarkPersonInput extends LarkPersonSubjectsInput {
  /** From `platformIdentities`, when the directory has seen this sender. */
  displayName?: string
  now?: number
}

/** Find or mint the `User` this principal's ids describe. */
export async function resolveLarkPerson(
  input: ResolveLarkPersonInput
): Promise<ExternalPersonResolution> {
  return resolveExternalPerson({
    subjects: larkPersonSubjects(input),
    displayName: input.displayName?.trim() || (await larkFallbackDisplayName(input.openId)),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

export interface BindLarkIdentityInput extends LarkPersonSubjectsInput {
  /** The person this principal's Lark ids should point at. */
  userId: string
  displayName?: string
  now?: number
}

/**
 * Point this principal's Lark ids at a named person — the operator's half of
 * resolution.
 *
 * Unlike `resolveLarkPerson`, this OVERWRITES a subject that already belongs
 * to somebody else, because that is precisely the case an operator reaches for
 * it: "this Lark account is actually Ada" is a correction, and refusing to
 * apply it would leave the registry saying something the operator has just
 * told it is wrong.
 *
 * The `logtoSubject` is not written even when the caller has one: it is filed
 * under the issuer that minted it, which this side never sees, so a row
 * written here would be a duplicate the sign-in writer never finds.
 */
export async function bindLarkIdentityTo(input: BindLarkIdentityInput): Promise<void> {
  const now = input.now ?? Date.now()
  const label = input.displayName?.trim()
  for (const subject of larkPersonSubjects(input)) {
    if (!subject.tenant) continue
    await linkExternalIdentity({
      userId: input.userId,
      provider: subject.provider,
      subject: subject.subject,
      tenant: subject.tenant,
      ...(label ? { label } : {}),
      now,
    })
  }
}
