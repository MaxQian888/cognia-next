import { safePath, validateTemplatePackageManifest } from "./package-manifest"

const manifest = () => ({
  schemaVersion: 1,
  apiVersion: "cognia.ai/templates/v1",
  id: "fixture.package",
  version: "1.0.0",
  name: "Fixture",
  entrypoints: ["skill.fixture@1.0.0"],
  definitions: [
    {
      id: "skill.fixture",
      version: "1.0.0",
      path: "definitions/fixture.json",
      sha256: "a".repeat(64),
    },
  ],
  assets: [],
})

test("validates the inert manifest without loading archive I/O", () => {
  const value = manifest()
  expect(validateTemplatePackageManifest(value)).toBe(value)
  expect(safePath("./definitions/fixture.json")).toBe("definitions/fixture.json")
})

test("rejects unsafe paths, duplicate identities and missing entrypoints", () => {
  expect(() => safePath("../private")).toThrow("escapes its root")
  const value = manifest()
  expect(() =>
    validateTemplatePackageManifest({ ...value, assets: [value.definitions[0]] })
  ).toThrow("duplicate path")
  expect(() =>
    validateTemplatePackageManifest({ ...value, entrypoints: ["missing@1.0.0"] })
  ).toThrow("entrypoint is missing")
})
