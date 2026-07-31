/** @jest-environment node */

import { ingestEvalAsset } from "./assets"

function file(
  bytes: number[],
  overrides: Partial<{ name: string; type: string; size: number }> = {}
) {
  const data = Uint8Array.from(bytes)
  return {
    name: overrides.name ?? "sample.png",
    type: overrides.type ?? "image/png",
    size: overrides.size ?? data.byteLength,
    arrayBuffer: async () => data.buffer,
  }
}

describe("evaluation asset ingestion", () => {
  it("encrypts and persists a local-only attachment before returning its content reference", async () => {
    const save = jest.fn(async () => undefined)
    const clear = jest.fn(async () => undefined)
    const part = await ingestEvalAsset(
      { accountId: "account-1", file: file([1, 2, 3]), retentionDays: 7 },
      {
        loadKey: async () => new Uint8Array(32),
        encrypt: jest.fn(async () => ({
          version: "cognia-eval-encrypted/v1" as const,
          algorithm: "AES-GCM" as const,
          iv: "iv",
          ciphertext: "ciphertext",
        })),
        save,
        clear,
        now: () => 1_000,
      }
    )

    expect(part).toMatchObject({
      type: "asset",
      mediaType: "image/png",
      name: "sample.png",
      privacy: "local-only",
      assetId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        digest: part.assetId,
        size: 3,
        referenceCount: 0,
        createdAt: 1_000,
        expiresAt: 604_801_000,
      })
    )
    expect(clear).not.toHaveBeenCalled()
  })

  it("records identified manual clearance and returns a cloud-eligible reference", async () => {
    const clear = jest.fn(async () => undefined)
    const part = await ingestEvalAsset(
      {
        accountId: "account-1",
        file: file([4]),
        clearance: { method: "manual", actorId: "reviewer-1" },
      },
      {
        loadKey: async () => new Uint8Array(32),
        encrypt: async () => ({
          version: "cognia-eval-encrypted/v1",
          algorithm: "AES-GCM",
          iv: "iv",
          ciphertext: "ciphertext",
        }),
        save: async () => undefined,
        clear,
        now: () => 20,
      }
    )

    expect(part.privacy).toBe("manual")
    expect(clear).toHaveBeenCalledWith(
      part.assetId,
      { method: "manual", actorId: "reviewer-1" },
      20
    )
  })

  it("requires evidence for scan clearance and rejects empty or changing files", async () => {
    await expect(
      ingestEvalAsset(
        {
          accountId: "account-1",
          file: file([1]),
          clearance: { method: "scan", scannerId: "", evidenceDigest: "" },
        },
        {}
      )
    ).rejects.toThrow(/scanner identity and evidence/i)
    await expect(ingestEvalAsset({ accountId: "account-1", file: file([]) })).rejects.toThrow(
      /cannot be empty/i
    )
    await expect(
      ingestEvalAsset({ accountId: "account-1", file: file([1], { size: 2 }) })
    ).rejects.toThrow(/size changed/i)
  })
})
