import * as crypto from "./index"

describe("lib/account-sync/crypto public surface", () => {
  it("exports the client key operations", () => {
    for (const name of [
      "AccountSyncCryptoError",
      "generateDeviceKeyMaterial",
      "importDeviceKeys",
      "parseDeviceKeyMaterial",
      "newRecoveryKey",
      "deriveRecoveryKeys",
      "assertRecoveryKeysMatch",
      "hpkeSeal",
      "hpkeOpen",
      "sealEpochEnvelopes",
      "openEpochEnvelope",
      "sealRequestName",
      "openRequestName",
      "verifiedKeyChain",
      "nextEpoch",
      "firstEpoch",
      "serializeKeyChain",
      "parseKeyChain",
      "newRequesterNonce",
      "newApproverNonce",
      "displayedSasCode",
      "signRegistryEntry",
      "deviceProofHeader",
      "enrollRequestPop",
    ]) {
      expect(typeof (crypto as Record<string, unknown>)[name]).toBe("function")
    }
  })

  it("keeps the JWK import helpers internal", () => {
    expect((crypto as Record<string, unknown>).importP256KeyPair).toBeUndefined()
    expect((crypto as Record<string, unknown>).generateP256Jwk).toBeUndefined()
  })
})
