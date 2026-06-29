// Storybook-only fixtures for the local-account subsystem
// (`components/account/**`). Dependency-free (types only).
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

const VERIFIER = {
  algorithm: "argon2id",
  salt: "c3Rvcnlib29r",
  hash: "ZGVhZGJlZWY=",
  params: { m: 19456, t: 2, p: 1 },
}

const STAMP = 1_700_000_000_000

export function makeAccount(over: Partial<LocalAccountRecord> = {}): LocalAccountRecord {
  return {
    id: "acct_ada",
    displayName: "Ada Lovelace",
    passwordVerifier: VERIFIER,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }
}

export function makeAccountSet(): LocalAccountRecord[] {
  return [
    makeAccount({ id: "acct_ada", displayName: "Ada Lovelace" }),
    makeAccount({ id: "acct_grace", displayName: "Grace Hopper" }),
    makeAccount({ id: "acct_alan", displayName: "Alan Turing" }),
  ]
}
