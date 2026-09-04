import { CatalogVerificationError } from "./catalog-types"

describe("CatalogVerificationError", () => {
  it("carries the reason and the role so callers can branch without parsing text", () => {
    const error = new CatalogVerificationError("rollback", "targets", "older than trusted")
    expect(error.reason).toBe("rollback")
    expect(error.role).toBe("targets")
    expect(error.name).toBe("CatalogVerificationError")
  })

  it("is a real Error, so it survives a throw and an instanceof check", () => {
    try {
      throw new CatalogVerificationError("expired", "timestamp", "stale feed")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(CatalogVerificationError)
      expect((error as CatalogVerificationError).message).toBe("stale feed")
    }
  })
})
