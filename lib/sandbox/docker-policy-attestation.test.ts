import type { MicrovmRequest } from "@cognia/plugin-sdk/api/sandbox"
import type { DockerSandboxConfig } from "@/types/sandbox"
import {
  attestDockerPolicy,
  containerPathFor,
  memoryBytesFor,
  nanoCpusFor,
} from "./docker-policy-attestation"

function config(overrides: Partial<DockerSandboxConfig> = {}): DockerSandboxConfig {
  return { image: "img", host: "127.0.0.1", port: 0, ...overrides }
}

/** A request asking for nothing the container has to provide. */
function request(overrides: Partial<MicrovmRequest> = {}): MicrovmRequest {
  return {
    writable: [],
    readable: [],
    targetFiles: [],
    maxCpuSeconds: 0,
    maxMemoryMb: 0,
    network: "on",
    networkHosts: [],
    ...overrides,
  }
}

describe("attestDockerPolicy", () => {
  it("attests a request that asks for nothing", () => {
    expect(attestDockerPolicy(config(), request())).toMatchObject({
      attested: true,
      failures: [],
    })
  })

  it("refuses a network-off request on a networked container", () => {
    // `docker exec` cannot detach a running container from its network, so
    // running this anyway would execute with network access the caller
    // believes it gave up.
    const result = attestDockerPolicy(config(), request({ network: "off" }))
    expect(result.attested).toBe(false)
    expect(result.failures).toContain("network-not-confined")
    expect(result.reason).toMatch(/network off/)
  })

  it("attests a network-off request on a container built with --network none", () => {
    expect(
      attestDockerPolicy(config({ networkMode: "none" }), request({ network: "off" })).attested
    ).toBe(true)
  })

  it("refuses an allowlist request rather than silently treating it as off or on", () => {
    // No container flag expresses an allowlist. Downgrading it to `off` would
    // break the call, and to `on` would quietly widen it.
    expect(attestDockerPolicy(config(), request({ network: "allowlist" })).attested).toBe(false)
    expect(
      attestDockerPolicy(config({ networkMode: "none" }), request({ network: "allowlist" }))
        .attested
    ).toBe(true)
  })

  it("refuses a cpu or memory ceiling the container was not built with", () => {
    const result = attestDockerPolicy(config(), request({ maxCpuSeconds: 30, maxMemoryMb: 512 }))
    expect(result.failures).toEqual(expect.arrayContaining(["cpu-not-capped", "memory-not-capped"]))
  })

  it("attests ceilings the container was built with", () => {
    expect(
      attestDockerPolicy(
        config({ cpus: "1.5", memoryMb: 2048 }),
        request({ maxCpuSeconds: 30, maxMemoryMb: 512 })
      ).attested
    ).toBe(true)
  })

  it("treats a zero ceiling as no ceiling", () => {
    expect(
      attestDockerPolicy(config({ cpus: "0", memoryMb: 0 }), request({ maxCpuSeconds: 1 })).attested
    ).toBe(false)
  })

  it("refuses writable paths when nothing is mounted into the container", () => {
    // A host path means nothing inside a container. Accepting it would write
    // to a path that either does not exist or belongs to something else.
    const result = attestDockerPolicy(config(), request({ writable: ["/Users/me/project"] }))
    expect(result.failures).toContain("no-workspace-mount")
  })

  it("refuses a path outside the mounted directory", () => {
    const mounted = config({
      workspaceMount: { hostPath: "/Users/me/project", containerPath: "/workspace" },
    })
    expect(
      attestDockerPolicy(mounted, request({ targetFiles: ["/etc/passwd"] })).failures
    ).toContain("path-outside-workspace")
  })

  it("attests paths under the mounted directory", () => {
    const mounted = config({
      workspaceMount: { hostPath: "/Users/me/project", containerPath: "/workspace" },
    })
    expect(
      attestDockerPolicy(
        mounted,
        request({ writable: ["/Users/me/project/src"], targetFiles: ["/Users/me/project/a.ts"] })
      ).attested
    ).toBe(true)
  })

  it("reports every unmet part at once", () => {
    // One refusal should show the whole gap, not send the operator round the
    // loop discovering one missing flag at a time.
    const result = attestDockerPolicy(
      config(),
      request({
        network: "off",
        maxCpuSeconds: 1,
        maxMemoryMb: 1,
        writable: ["/Users/me/project"],
      })
    )
    expect(result.failures).toHaveLength(4)
  })
})

describe("containerPathFor", () => {
  const mounted = config({
    workspaceMount: { hostPath: "/Users/me/project", containerPath: "/workspace" },
  })

  it("rebases a host path onto the mount", () => {
    expect(containerPathFor(mounted, "/Users/me/project/src/a.ts")).toBe("/workspace/src/a.ts")
  })

  it("maps the mount root itself", () => {
    expect(containerPathFor(mounted, "/Users/me/project")).toBe("/workspace")
  })

  it("returns null outside the mount rather than guessing", () => {
    // Guessing a container path for an unmounted host path would write
    // somewhere the caller never named.
    expect(containerPathFor(mounted, "/etc/passwd")).toBeNull()
    expect(containerPathFor(config(), "/Users/me/project/a.ts")).toBeNull()
  })

  it("does not treat a sibling directory as inside the mount", () => {
    expect(containerPathFor(mounted, "/Users/me/project-other/a.ts")).toBeNull()
  })
})

describe("docker unit conversions", () => {
  it("converts cpus to the nano-cpus docker reports", () => {
    // Verified against a real container: `--cpus 1.5` inspects as 1500000000.
    expect(nanoCpusFor("1.5")).toBe(1_500_000_000)
    expect(nanoCpusFor(undefined)).toBe(0)
    expect(nanoCpusFor("0")).toBe(0)
    expect(nanoCpusFor("not-a-number")).toBe(0)
  })

  it("converts MiB to the bytes docker reports", () => {
    // Verified against a real container: `--memory 512m` inspects as 536870912.
    expect(memoryBytesFor(512)).toBe(536_870_912)
    expect(memoryBytesFor(undefined)).toBe(0)
    expect(memoryBytesFor(0)).toBe(0)
  })
})
