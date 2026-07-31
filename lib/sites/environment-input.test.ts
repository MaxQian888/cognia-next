import { parseSiteEnvironmentInput } from "./environment-input"

it("parses dotenv-style values without interpreting or trimming their contents", () => {
  expect(
    parseSiteEnvironmentInput("# comment\nAPI_ORIGIN=https://example.com\nTOKEN=a=b=c\n")
  ).toEqual({
    API_ORIGIN: "https://example.com",
    TOKEN: "a=b=c",
  })
})

it("rejects malformed and duplicate keys", () => {
  expect(() => parseSiteEnvironmentInput("NO_EQUALS")).toThrow("line 1")
  expect(() => parseSiteEnvironmentInput("BAD-KEY=x")).toThrow("key")
  expect(() => parseSiteEnvironmentInput("A=1\nA=2")).toThrow("duplicate")
})
