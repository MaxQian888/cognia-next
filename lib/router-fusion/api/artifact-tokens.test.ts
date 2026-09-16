import {
  __resetArtifactTokenKeyForTesting,
  ARTIFACT_READ_TOKEN_TTL_MS,
  issueArtifactReadToken,
  verifyArtifactReadToken,
} from "./artifact-tokens"

const NOW = 1_800_000_000_000

beforeEach(() => __resetArtifactTokenKeyForTesting())

describe("artifact read tokens", () => {
  it("lasts the spec's sixty seconds", async () => {
    const issued = await issueArtifactReadToken("art-1", "key-a", NOW)
    expect(ARTIFACT_READ_TOKEN_TTL_MS).toBe(60_000)
    expect(issued.expiresAt).toBe(NOW + 60_000)
    await expect(
      verifyArtifactReadToken(issued.token, "art-1", "key-a", NOW + 59_999)
    ).resolves.toBe("valid")
    await expect(
      verifyArtifactReadToken(issued.token, "art-1", "key-a", NOW + 60_000)
    ).resolves.toBe("expired")
  })

  it("grants one artifact to one key and nothing else", async () => {
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    await expect(verifyArtifactReadToken(token, "art-2", "key-a", NOW)).resolves.toBe("invalid")
    await expect(verifyArtifactReadToken(token, "art-1", "key-b", NOW)).resolves.toBe("invalid")
    await expect(verifyArtifactReadToken(token, "art-1", null, NOW)).resolves.toBe("invalid")
  })

  it("refuses a token whose expiry was edited", async () => {
    const { token, expiresAt } = await issueArtifactReadToken("art-1", "key-a", NOW)
    const forged = `${expiresAt + 3_600_000}${token.slice(token.indexOf("."))}`
    await expect(verifyArtifactReadToken(forged, "art-1", "key-a", NOW)).resolves.toBe("invalid")
  })

  it.each([undefined, 42, "", "no-dot", "abc.def", "123.!!!", ".sig"])(
    "treats %p as no token at all",
    async (token) => {
      await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("invalid")
    }
  )

  it("forgets every token when the brain restarts", async () => {
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    __resetArtifactTokenKeyForTesting()
    await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("invalid")
  })
})
