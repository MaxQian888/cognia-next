import { createHash } from "node:crypto"

export type RuntimeHashInput = string | Uint8Array

export interface RuntimeHasher {
  update(data: RuntimeHashInput): RuntimeHasher
  digest(encoding: "hex"): string
}

interface BunCryptoRuntime {
  CryptoHasher: new (algorithm: string) => RuntimeHasher
}

const detectedBunRuntime = (globalThis as typeof globalThis & { Bun?: Partial<BunCryptoRuntime> })
  .Bun

/** Create an incremental hash using Bun when callable, with a Node fallback. */
export function createRuntimeHasher(
  algorithm: string,
  runtime: Partial<BunCryptoRuntime> | null | undefined = detectedBunRuntime
): RuntimeHasher {
  if (typeof runtime?.CryptoHasher === "function") {
    return new runtime.CryptoHasher(algorithm)
  }
  return createHash(algorithm) as RuntimeHasher
}

/** Hash one string/byte buffer to lowercase hexadecimal. */
export function hashHex(algorithm: string, data: RuntimeHashInput): string {
  return createRuntimeHasher(algorithm).update(data).digest("hex")
}
