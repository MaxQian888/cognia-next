/**
 * Binding a LocalProfile to a `User` — ADR-0149 §9.
 *
 * # What binding is, and is not
 *
 * A LocalProfile (`acct_…`) is an encryption and unlock boundary: a password
 * and a physical Dexie database. A `User` (`usr_…`) is a person. ADR-0149
 * separates them precisely so that "offline, I am still me" keeps working —
 * a profile unlocks on its own, and the person is a binding laid on top.
 *
 * So binding does NOT gate the profile. Nothing here is consulted before the
 * local data opens; signing out leaves every local row exactly where it was.
 *
 * # Why a conflicting bind fails instead of replacing
 *
 * A profile that is already bound holds that person's data. Letting a second
 * person sign in and silently take the binding over would attribute one
 * human's conversations, issues and plans to another — quietly, and with no
 * event anyone would notice. `bind` is therefore idempotent for the same
 * subject and refuses a different one; taking a profile over is `rebind`, which
 * a caller reaches only from an explicit "use this profile as someone else"
 * choice.
 *
 * This is the same instinct as `host_identity.rs` pinning a namespace to the
 * first verifier it sees, without that module's problem: here the conflict is
 * recoverable and named, rather than a permanent refusal.
 */

import { CogniaAccountRegistryDB, type UserBindingRow } from "@/lib/accounts/account-db"
import { isOrgId, isUserId } from "@/types/identity"

export type UserBindingErrorCode =
  "invalid-user-id" | "invalid-org-id" | "already-bound-to-another-user" | "not-bound"

export class UserBindingError extends Error {
  readonly code: UserBindingErrorCode
  /** The binding that is in the way, when the failure is a conflict. */
  readonly existing?: UserBindingRow

  constructor(code: UserBindingErrorCode, message: string, existing?: UserBindingRow) {
    super(message)
    this.name = "UserBindingError"
    this.code = code
    this.existing = existing
  }
}

export interface BindUserInput {
  localAccountId: string
  userId: string
  orgId?: string
  logtoSubject: string
  logtoIssuer: string
  displayName?: string
  email?: string
  now?: number
}

/**
 * True when an incoming sign-in is the same person as the existing binding.
 *
 * Compared on BOTH the local user id and the Logto subject: the subject alone
 * would let a re-minted local id look like a takeover, and the local id alone
 * would let two different Logto subjects that were mapped to one user id in
 * some earlier bug pass silently.
 */
export function isSameBoundUser(existing: UserBindingRow, input: BindUserInput): boolean {
  return existing.userId === input.userId && existing.logtoSubject === input.logtoSubject
}

function assertBindInput(input: BindUserInput): void {
  if (!isUserId(input.userId)) {
    throw new UserBindingError(
      "invalid-user-id",
      `"${input.userId}" is not a user id — ADR-0149 §1 reserves the usr_ prefix for people.`
    )
  }
  if (input.orgId !== undefined && !isOrgId(input.orgId)) {
    throw new UserBindingError(
      "invalid-org-id",
      `"${input.orgId}" is not an org id — the tnt_ ids of ADR-0059 are renamed, not reused.`
    )
  }
}

function rowFrom(input: BindUserInput, boundAt: number, now: number): UserBindingRow {
  const row: UserBindingRow = {
    localAccountId: input.localAccountId,
    userId: input.userId,
    logtoSubject: input.logtoSubject,
    logtoIssuer: input.logtoIssuer,
    boundAt,
    updatedAt: now,
  }
  // Absent stays absent: Dexie indexes `orgId`, and writing `undefined` into an
  // indexed field drops the row out of that index entirely.
  if (input.orgId) row.orgId = input.orgId
  if (input.displayName) row.displayName = input.displayName
  if (input.email) row.email = input.email
  return row
}

export class UserBindingRegistry {
  constructor(private readonly db: CogniaAccountRegistryDB = new CogniaAccountRegistryDB()) {}

  async get(localAccountId: string): Promise<UserBindingRow | null> {
    return (await this.db.userBindings.get(localAccountId)) ?? null
  }

  /** Every profile on this machine bound to one person. Usually one; not always. */
  async listByUser(userId: string): Promise<UserBindingRow[]> {
    return this.db.userBindings.where("userId").equals(userId).toArray()
  }

  async listAll(): Promise<UserBindingRow[]> {
    return this.db.userBindings.toArray()
  }

  /**
   * Bind, or refresh an existing binding for the same person.
   *
   * Throws `already-bound-to-another-user` when the profile belongs to someone
   * else; the error carries the existing row so a caller can name them.
   */
  async bind(input: BindUserInput): Promise<UserBindingRow> {
    assertBindInput(input)
    const now = input.now ?? Date.now()
    let result: UserBindingRow | undefined

    await this.db.transaction("rw", this.db.userBindings, async () => {
      const existing = await this.db.userBindings.get(input.localAccountId)
      if (existing && !isSameBoundUser(existing, input)) {
        throw new UserBindingError(
          "already-bound-to-another-user",
          `Profile ${input.localAccountId} is already bound to ${existing.userId}.`,
          existing
        )
      }
      result = rowFrom(input, existing?.boundAt ?? now, now)
      await this.db.userBindings.put(result)
    })

    return result as UserBindingRow
  }

  /** Take a profile over for a different person. The explicit half of `bind`. */
  async rebind(input: BindUserInput): Promise<UserBindingRow> {
    assertBindInput(input)
    const now = input.now ?? Date.now()
    const row = rowFrom(input, now, now)
    await this.db.userBindings.put(row)
    return row
  }

  /** Sign out. Idempotent, and it never touches the profile's data. */
  async unbind(localAccountId: string): Promise<void> {
    await this.db.userBindings.delete(localAccountId)
  }

  /**
   * Move the binding to the server-assigned id, remembering the old one.
   *
   * Not a takeover: the person is the same, only the id the server chose for
   * them differs from the one this machine derived before the server existed.
   * Idempotent, and a no-op when the ids already agree.
   */
  async reconcileUserId(
    localAccountId: string,
    canonicalUserId: string,
    now = Date.now()
  ): Promise<UserBindingRow> {
    if (!isUserId(canonicalUserId)) {
      throw new UserBindingError(
        "invalid-user-id",
        `"${canonicalUserId}" is not a user id, so it cannot be the canonical one.`
      )
    }
    let result: UserBindingRow | undefined
    await this.db.transaction("rw", this.db.userBindings, async () => {
      const existing = await this.db.userBindings.get(localAccountId)
      if (!existing) {
        throw new UserBindingError("not-bound", `Profile ${localAccountId} is not bound.`)
      }
      if (existing.userId === canonicalUserId) {
        result = existing
        return
      }
      const legacyUserIds = [...(existing.legacyUserIds ?? [])]
      if (!legacyUserIds.includes(existing.userId)) legacyUserIds.push(existing.userId)
      result = { ...existing, userId: canonicalUserId, legacyUserIds, updatedAt: now }
      await this.db.userBindings.put(result)
    })
    return result as UserBindingRow
  }
}
