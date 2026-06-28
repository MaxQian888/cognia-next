import { invoke } from "@tauri-apps/api/core"

import { clonePasswordVerifier, type PasswordVerifierRecord } from "./account-types"
import { assertPasswordMeetsPolicy } from "./password-policy"

export const ACCOUNT_PASSWORD_CREATE_VERIFIER_COMMAND = "account_password_create_verifier"
export const ACCOUNT_PASSWORD_VERIFY_COMMAND = "account_password_verify"

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export async function createPasswordVerifier(password: string): Promise<PasswordVerifierRecord> {
  assertUsablePassword(password)
  assertPasswordMeetsPolicy(password)
  try {
    const verifier = await (invoke as InvokeFn)<unknown>(ACCOUNT_PASSWORD_CREATE_VERIFIER_COMMAND, {
      password,
    })
    return normalizePasswordVerifier(verifier)
  } catch (error) {
    throw toError(error)
  }
}

export async function verifyPassword(
  password: string,
  verifier: PasswordVerifierRecord
): Promise<boolean> {
  assertUsablePassword(password)
  try {
    const result = await (invoke as InvokeFn)<unknown>(ACCOUNT_PASSWORD_VERIFY_COMMAND, {
      password,
      verifier,
    })
    if (typeof result !== "boolean") {
      throw new Error("Native password verification returned a malformed result.")
    }
    return result
  } catch (error) {
    throw toError(error)
  }
}

function assertUsablePassword(password: string): void {
  if (!password.trim()) {
    throw new Error("Local account password is required.")
  }
}

function normalizePasswordVerifier(value: unknown): PasswordVerifierRecord {
  if (!isRecord(value)) {
    throw new Error("Native password verifier payload is malformed.")
  }
  const verifier = value as Partial<PasswordVerifierRecord>
  if (
    typeof verifier.algorithm !== "string" ||
    verifier.algorithm.length === 0 ||
    typeof verifier.salt !== "string" ||
    verifier.salt.length === 0 ||
    typeof verifier.hash !== "string" ||
    verifier.hash.length === 0 ||
    !isRecord(verifier.params)
  ) {
    throw new Error("Native password verifier payload is malformed.")
  }
  return clonePasswordVerifier(verifier as PasswordVerifierRecord)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === "string") return new Error(error)
  return new Error("Native password command failed.")
}
