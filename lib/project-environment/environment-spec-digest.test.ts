import fixtures from "@/protocol/environment-spec-fixtures.json"
import type { EnvironmentSpec } from "@/types/sandbox/environment-spec"

import {
  canonicalEnvironmentSpec,
  computeEnvironmentSpecDigest,
  environmentRuntimeFieldsDigest,
  sealEnvironmentSpec,
} from "./environment-spec-digest"

interface FixtureCase {
  name: string
  spec: EnvironmentSpec
  canonical: string
  specDigest: string
  runtimeFieldsDigest: string
}

const cases = (fixtures as unknown as { cases: FixtureCase[] }).cases

describe("environment spec digests", () => {
  it("has the shared fixture's cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(3)
  })

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    "%s matches the digests the Rust crate asserts",
    async (_name, entry) => {
      expect(entry.spec.specDigest).toBe(entry.specDigest)
      expect(canonicalEnvironmentSpec(entry.spec)).toBe(entry.canonical)
      await expect(computeEnvironmentSpecDigest(entry.spec)).resolves.toBe(entry.specDigest)
      await expect(environmentRuntimeFieldsDigest(entry.spec)).resolves.toBe(
        entry.runtimeFieldsDigest
      )
    }
  )

  it("excludes explain and specDigest from the digest", async () => {
    const base = cases[0]!.spec
    const withExplain: EnvironmentSpec = {
      ...base,
      specDigest: "0".repeat(64),
      explain: { steps: [{ layer: "project-setting", outcome: "chosen", code: "x" }] },
    }
    await expect(computeEnvironmentSpecDigest(withExplain)).resolves.toBe(base.specDigest)
  })

  it("seals a body with its digest right after version", async () => {
    const { specDigest: _digest, ...body } = cases[1]!.spec
    const sealed = await sealEnvironmentSpec(body)
    expect(sealed.specDigest).toBe(cases[1]!.specDigest)
    expect(Object.keys(sealed).slice(0, 2)).toEqual(["version", "specDigest"])
  })

  it("keeps historical digests for absent remote env and binds new runtime settings", async () => {
    const base = cases[0]!.spec
    const digest = await environmentRuntimeFieldsDigest(base)
    await expect(computeEnvironmentSpecDigest({ ...base, remoteEnv: {} })).resolves.toBe(
      base.specDigest
    )
    await expect(environmentRuntimeFieldsDigest({ ...base, remoteEnv: {} })).resolves.toBe(digest)
    for (const added of [
      { remoteEnv: { IMAGE_SETTING: null } },
      { remoteEnv: { PATH: "${containerEnv:PATH}:/custom/bin" } },
      { workspaceFolder: "/workspace/app" },
      { lifecycleTimeoutMs: 1000 },
    ]) {
      const changed = { ...base, ...added }
      await expect(computeEnvironmentSpecDigest(changed)).resolves.not.toBe(base.specDigest)
      await expect(environmentRuntimeFieldsDigest(changed)).resolves.not.toBe(digest)
    }
  })

  it("is sensitive to every runtime field and to key order only through content", async () => {
    const base = cases[1]!.spec
    const baseline = await computeEnvironmentSpecDigest(base)
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as EnvironmentSpec
    await expect(computeEnvironmentSpecDigest(reordered)).resolves.toBe(baseline)

    const changedPort: EnvironmentSpec = { ...base, forwardPorts: [{ port: 3001 }] }
    await expect(computeEnvironmentSpecDigest(changedPort)).resolves.not.toBe(baseline)
    await expect(environmentRuntimeFieldsDigest(changedPort)).resolves.not.toBe(
      await environmentRuntimeFieldsDigest(base)
    )

    const otherImage: EnvironmentSpec = {
      ...base,
      image: { ...base.image, repository: "acme/other" },
    }
    await expect(environmentRuntimeFieldsDigest(otherImage)).resolves.toBe(
      await environmentRuntimeFieldsDigest(base)
    )
  })
})
