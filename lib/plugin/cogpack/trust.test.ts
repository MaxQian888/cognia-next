const trustPublisher = jest.fn(async (..._args: unknown[]) => ({}))
jest.mock("@/lib/db/trusted-publishers", () => ({
  trustPublisher: (...args: unknown[]) => trustPublisher(...args),
}))
jest.mock("@/lib/plugin/core/plugins-policy-storage", () => ({ readPolicy: jest.fn() }))
jest.mock("@/lib/plugin/package/http-installer", () => ({ isPublisherKeyTrusted: jest.fn() }))
jest.mock("@/lib/templates/publisher-identity", () => ({
  publisherFingerprint: jest.fn(async (key: string) => `fp:${key}`),
}))

import { resolveCogpackTrust, trustCogpackSigner, type CogpackTrustDeps } from "./trust"

const signature = {
  algorithm: "ed25519" as const,
  publisher: "Ada",
  publicKey: "KEY",
  signature: "SIG",
}

function deps(
  policy: { signatureRequired?: boolean; trustedPublishersOnly?: boolean },
  trusted = false
): CogpackTrustDeps {
  return {
    isTrusted: async () => trusted,
    readPolicy: () => ({ signatureRequired: false, trustedPublishersOnly: false, ...policy }),
    fingerprint: async (key) => `fp:${key}`,
  }
}

describe("resolveCogpackTrust", () => {
  it("lets an unsigned cogpack through with a warning unless the policy requires signatures", async () => {
    await expect(resolveCogpackTrust(undefined, deps({}))).resolves.toEqual({ trust: "unsigned" })
    await expect(
      resolveCogpackTrust(undefined, deps({ signatureRequired: true }))
    ).resolves.toEqual({
      trust: "unsigned",
      refusedBy: "signature-required",
    })
    await expect(
      resolveCogpackTrust(undefined, deps({ trustedPublishersOnly: true }))
    ).resolves.toEqual({ trust: "unsigned", refusedBy: "trusted-publishers-only" })
  })

  it("knows a trusted signer and refuses an unknown one only under trusted-publishers-only", async () => {
    await expect(resolveCogpackTrust(signature, deps({}, true))).resolves.toEqual({
      trust: "trusted",
      fingerprint: "fp:KEY",
    })
    await expect(
      resolveCogpackTrust(signature, deps({ signatureRequired: true }))
    ).resolves.toEqual({
      trust: "signed-unknown",
      fingerprint: "fp:KEY",
    })
    await expect(
      resolveCogpackTrust(signature, deps({ trustedPublishersOnly: true }))
    ).resolves.toEqual({
      trust: "signed-unknown",
      fingerprint: "fp:KEY",
      refusedBy: "trusted-publishers-only",
    })
  })
})

describe("trustCogpackSigner", () => {
  it("adds the signer to the shared publisher ledger", async () => {
    await trustCogpackSigner(signature)
    expect(trustPublisher).toHaveBeenCalledWith({
      publicKey: "KEY",
      fingerprint: "fp:KEY",
      authorName: "Ada",
    })
  })
})
