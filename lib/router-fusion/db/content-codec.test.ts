import { AccountContentCipher } from "@/lib/accounts/content-cipher"

import { RouterFusionInfrastructureError } from "../gate/faults"
import { fusionContentCodec } from "./content-codec"

const ACCOUNT = "acct_router_fusion_test"
const FUSION_NAME = `cognia-account-${ACCOUNT}-encrypted-v1-router-fusion-v1`

describe("fusion content codec", () => {
  it("stores plaintext for a database that is not account-scoped", async () => {
    const codec = fusionContentCodec("cognia-next-router-fusion-v1", {
      cipherFor: () => {
        throw new Error("must not be asked")
      },
    })
    expect(codec.encrypted).toBe(false)
    const sealed = await codec.seal("fusionArtifacts", "a1", "content", "hello")
    expect(sealed).toEqual({ content: "hello", encryptedContent: null })
    await expect(codec.open("fusionArtifacts", "a1", "content", sealed)).resolves.toBe("hello")
  })

  it("seals content for an account database and binds it to table, key and field", async () => {
    const cipher = await AccountContentCipher.createForTesting(ACCOUNT, FUSION_NAME)
    const codec = fusionContentCodec(FUSION_NAME, { cipherFor: () => cipher })
    const sealed = await codec.seal("fusionArtifacts", "a1", "content", "secret answer")
    expect(sealed.content).toBeNull()
    expect(JSON.stringify(sealed.encryptedContent)).not.toContain("secret answer")
    await expect(codec.open("fusionArtifacts", "a1", "content", sealed)).resolves.toBe(
      "secret answer"
    )
    // Moving the envelope to another row fails authentication.
    await expect(codec.open("fusionArtifacts", "a2", "content", sealed)).rejects.toThrow()
  })

  it("refuses to seal or open when the vault is locked", async () => {
    const codec = fusionContentCodec(FUSION_NAME, { cipherFor: () => null })
    await expect(codec.seal("fusionArtifacts", "a1", "content", "x")).rejects.toMatchObject({
      code: "cipher_locked",
    })
    await expect(
      codec.open("fusionArtifacts", "a1", "content", { content: null, encryptedContent: null })
    ).rejects.toBeInstanceOf(RouterFusionInfrastructureError)
  })

  it("never reads plaintext out of an encrypted database", async () => {
    const cipher = await AccountContentCipher.createForTesting(ACCOUNT, FUSION_NAME)
    const codec = fusionContentCodec(FUSION_NAME, { cipherFor: () => cipher })
    await expect(
      codec.open("fusionArtifacts", "a1", "content", { content: "planted", encryptedContent: null })
    ).rejects.toMatchObject({ code: "internal" })
  })
})
