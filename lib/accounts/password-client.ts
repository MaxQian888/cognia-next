import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/platform/detect"

import { clonePasswordVerifier, type PasswordVerifierRecord } from "./account-types"
import { assertPasswordMeetsPolicy } from "./password-policy"

export const ACCOUNT_PASSWORD_CREATE_VERIFIER_COMMAND = "account_password_create_verifier"
export const ACCOUNT_PASSWORD_VERIFY_COMMAND = "account_password_verify"

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

const WEB_PASSWORD_ALGORITHM = "pbkdf2-sha256-v1"
const WEB_PASSWORD_ITERATIONS = 600_000
const WEB_PASSWORD_OUTPUT_LENGTH = 32

export async function createPasswordVerifier(password: string): Promise<PasswordVerifierRecord> {
  assertUsablePassword(password)
  assertPasswordMeetsPolicy(password)
  if (!isTauri()) {
    return createWebPasswordVerifier(password)
  }
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
  if (!isTauri()) {
    return verifyWebPassword(password, verifier)
  }
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

async function createWebPasswordVerifier(password: string): Promise<PasswordVerifierRecord> {
  const salt = randomBytes(16)
  const hash = await deriveWebPasswordHash(password, salt, WEB_PASSWORD_ITERATIONS)
  return {
    algorithm: WEB_PASSWORD_ALGORITHM,
    salt: encodeBase64(salt),
    hash: encodeBase64(hash),
    params: {
      iterations: WEB_PASSWORD_ITERATIONS,
      hash: "SHA-256",
      outputLength: WEB_PASSWORD_OUTPUT_LENGTH,
    },
  }
}

async function verifyWebPassword(
  password: string,
  verifier: PasswordVerifierRecord
): Promise<boolean> {
  if (
    verifier.algorithm !== WEB_PASSWORD_ALGORITHM ||
    verifier.params.iterations !== WEB_PASSWORD_ITERATIONS ||
    verifier.params.hash !== "SHA-256" ||
    verifier.params.outputLength !== WEB_PASSWORD_OUTPUT_LENGTH
  ) {
    throw new Error("This password verifier is not supported in the browser runtime.")
  }

  const expected = decodeBase64(verifier.hash)
  const actual = await deriveWebPasswordHash(
    password,
    decodeBase64(verifier.salt),
    WEB_PASSWORD_ITERATIONS
  )
  if (expected.length !== actual.length) return false

  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index]! ^ actual[index]!
  }
  return difference === 0
}

async function deriveWebPasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Web Crypto API is required to manage a browser account password.")
  }
  const material = await subtle.importKey(
    "raw",
    toBufferSource(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toBufferSource(salt),
      iterations,
    },
    material,
    WEB_PASSWORD_OUTPUT_LENGTH * 8
  )
  return new Uint8Array(bits)
}

function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random source is required to manage a browser account password.")
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
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
