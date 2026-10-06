import { normalizeOmpProfile, resolveOmpPaths, projectOmpConfig } from "./config"
it("isolates named profiles and honors an explicitly empty canonical profile env", () => {
  expect(
    resolveOmpPaths({ homeDir: "/home/me", cwd: "/work", profile: "team", agentDir: "/override" })
      .agentDir
  ).toBe("/home/me/.omp/profiles/team/agent")
  expect(
    resolveOmpPaths({
      homeDir: "/home/me",
      cwd: "/work",
      env: { OMP_PROFILE: "", PI_PROFILE: "team", PI_CODING_AGENT_DIR: "/override" },
    }).agentDir
  ).toBe("/override")
  expect(
    resolveOmpPaths({ homeDir: "/home/me", cwd: "/work", profile: "team" }).projectConfigFile
  ).toBe("/work/.omp/config.yml")
})
it("rejects traversal and reserved profile names", () => {
  for (const name of ["../x", "A", "nul", "con.txt", "x.", "a/b"])
    expect(() => normalizeOmpProfile(name)).toThrow()
  expect(normalizeOmpProfile(" default ")).toBeUndefined()
})
it("projects parsed native config without mutations or migration guesses", () => {
  const source = { models: { default: "provider/model" }, future: { enabled: true } }
  const projected = projectOmpConfig(source)
  expect(projected.settings).toEqual(source)
  ;(projected.settings.future as { enabled: boolean }).enabled = false
  expect(source.future.enabled).toBe(true)
  expect(() => projectOmpConfig([])).toThrow()
  expect(() => projectOmpConfig({ bad: Infinity })).toThrow()
})
