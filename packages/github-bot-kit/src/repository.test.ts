import { isRepositoryName, parseRepository, REPOSITORY_PATTERN, resourceId } from "./repository"

it("accepts owner/repo and refuses anything that changes the API path", () => {
  for (const ok of ["acme/widgets", "a.b/c_d-e", "A/B.git"]) expect(isRepositoryName(ok)).toBe(true)
  for (const bad of ["acme", "a/b/c", "../x", "a/..", "./b", "a b/c", "a/b?x", 7, null]) {
    expect(isRepositoryName(bad)).toBe(false)
  }
  expect(REPOSITORY_PATTERN.test("acme/widgets")).toBe(true)
})

it("parses an installation setting with the caller's setup wording", () => {
  expect(parseRepository("acme/widgets", "set it")).toBe("acme/widgets")
  for (const unset of [undefined, null, ""]) {
    expect(() => parseRepository(unset, "set it")).toThrow("set it")
  }
  expect(() => parseRepository("nope", "set it")).toThrow("repository must be owner/repo")
})

it("derives a case-insensitive resource id", () => {
  expect(resourceId("Acme/Widgets", 8)).toBe("acme/widgets#8")
})
