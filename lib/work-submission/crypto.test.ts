/** @jest-environment jsdom */
import { webcrypto } from "node:crypto"

jest.mock("@/lib/ai/eval/artifact-crypto", () => ({
  loadOrCreateAccountArtifactKey: jest.fn(async () => new Uint8Array(32).fill(7)),
}))

import { loadOrCreateAccountArtifactKey } from "@/lib/ai/eval/artifact-crypto"

import {
  openWorkSubmissionPayload,
  sealWorkSubmissionPayload,
  workSubmissionAad,
  WORK_SUBMISSION_KEY_ID,
  type WorkSubmissionCryptoScope,
} from "./crypto"

// jsdom ships no SubtleCrypto; the Node implementation is the same Web Crypto
// API the desktop and headless hosts use at runtime.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)

const deps = { loadKey: async () => KEY }

const scope: WorkSubmissionCryptoScope = {
  accountId: "account-1",
  submissionId: "submission-1",
  kind: "input-batch",
}

describe("workSubmissionAad", () => {
  it("binds account, submission, and payload half", () => {
    expect(workSubmissionAad(scope)).toBe("work-submission-v1:account-1:submission-1:input-batch")
  })

  it("differs across the two halves of one submission", () => {
    expect(workSubmissionAad({ ...scope, kind: "context-bundle" })).not.toBe(
      workSubmissionAad(scope)
    )
  })
})

describe("sealWorkSubmissionPayload", () => {
  it("round-trips a payload", async () => {
    const envelope = await sealWorkSubmissionPayload("the frozen prompt", scope, deps)
    expect(await openWorkSubmissionPayload(envelope, scope, deps)).toBe("the frozen prompt")
  })

  it("produces an AES-256-GCM envelope tagged with the contract key id", async () => {
    const envelope = await sealWorkSubmissionPayload("x", scope, deps)
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: "AES-256-GCM",
      keyId: WORK_SUBMISSION_KEY_ID,
    })
  })

  it("never emits the plaintext", async () => {
    const envelope = await sealWorkSubmissionPayload("super secret prompt", scope, deps)
    expect(JSON.stringify(envelope)).not.toContain("super secret prompt")
  })

  it("uses a fresh IV per seal, so identical inputs do not collide", async () => {
    const first = await sealWorkSubmissionPayload("same", scope, deps)
    const second = await sealWorkSubmissionPayload("same", scope, deps)
    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it("round-trips an empty payload", async () => {
    const envelope = await sealWorkSubmissionPayload("", scope, deps)
    expect(await openWorkSubmissionPayload(envelope, scope, deps)).toBe("")
  })

  it("round-trips multi-byte content without corrupting it", async () => {
    const text = JSON.stringify({ text: "会话输入 🧊", nested: ["ünïcode"] })
    const envelope = await sealWorkSubmissionPayload(text, scope, deps)
    expect(await openWorkSubmissionPayload(envelope, scope, deps)).toBe(text)
  })
})

describe("openWorkSubmissionPayload", () => {
  it("refuses an envelope sealed for another submission", async () => {
    // Transplanting a ciphertext would let a retry replay the wrong input,
    // which is exactly what freezing the input is meant to rule out.
    const envelope = await sealWorkSubmissionPayload("input", scope, deps)
    await expect(
      openWorkSubmissionPayload(envelope, { ...scope, submissionId: "submission-2" }, deps)
    ).rejects.toThrow()
  })

  it("refuses an envelope sealed for the other half of the same submission", async () => {
    const envelope = await sealWorkSubmissionPayload("input", scope, deps)
    await expect(
      openWorkSubmissionPayload(envelope, { ...scope, kind: "context-bundle" }, deps)
    ).rejects.toThrow()
  })

  it("refuses an envelope sealed for another account", async () => {
    const envelope = await sealWorkSubmissionPayload("input", scope, deps)
    await expect(
      openWorkSubmissionPayload(envelope, { ...scope, accountId: "account-2" }, deps)
    ).rejects.toThrow()
  })

  it("refuses a different key", async () => {
    const envelope = await sealWorkSubmissionPayload("input", scope, deps)
    await expect(
      openWorkSubmissionPayload(envelope, scope, { loadKey: async () => OTHER_KEY })
    ).rejects.toThrow()
  })

  it("refuses a tampered ciphertext", async () => {
    const envelope = await sealWorkSubmissionPayload("input", scope, deps)
    const flipped = Buffer.from(envelope.ciphertext, "base64")
    flipped[0] ^= 0xff
    await expect(
      openWorkSubmissionPayload(
        { ...envelope, ciphertext: flipped.toString("base64") },
        scope,
        deps
      )
    ).rejects.toThrow()
  })

  it("refuses an unsupported envelope version", async () => {
    const envelope = await sealWorkSubmissionPayload("input", scope, deps)
    await expect(
      openWorkSubmissionPayload({ ...envelope, version: 2 as 1 }, scope, deps)
    ).rejects.toThrow()
  })
})

describe("key resolution", () => {
  it("asks for the key once per operation using the account id", async () => {
    const loadKey = jest.fn(async () => KEY)
    await sealWorkSubmissionPayload("x", scope, { loadKey })
    expect(loadKey).toHaveBeenCalledTimes(1)
    expect(loadKey).toHaveBeenCalledWith("account-1")
  })

  it("surfaces a key-provisioning failure rather than writing unencrypted", async () => {
    await expect(
      sealWorkSubmissionPayload("x", scope, {
        loadKey: async () => {
          throw new Error("vault locked")
        },
      })
    ).rejects.toThrow("vault locked")
  })

  it("rejects a key that is not 256-bit", async () => {
    await expect(
      sealWorkSubmissionPayload("x", scope, { loadKey: async () => new Uint8Array(16) })
    ).rejects.toThrow()
  })

  it("defaults to the account artifact key for the work-submission domain", async () => {
    // The production path: with no injected loader, the module must reach for
    // the account-scoped key under its own domain rather than borrowing
    // another subsystem's key material.
    const mocked = loadOrCreateAccountArtifactKey as jest.MockedFunction<
      typeof loadOrCreateAccountArtifactKey
    >
    mocked.mockClear()
    const envelope = await sealWorkSubmissionPayload("via default key", scope)
    expect(mocked).toHaveBeenCalledWith("account-1", "work-submission")
    expect(await openWorkSubmissionPayload(envelope, scope)).toBe("via default key")
  })
})

describe("host without Web Crypto", () => {
  it("fails loudly instead of degrading to plaintext", async () => {
    const original = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true })
    try {
      await expect(sealWorkSubmissionPayload("x", scope, deps)).rejects.toThrow(
        "Web Crypto is required for work submission encryption"
      )
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true })
    }
  })
})
