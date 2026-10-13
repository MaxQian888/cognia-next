import {
  gatherNodeSystemDetails,
  parseOsRelease,
  type NodeSystemDetailsDeps,
} from "./node-system-details"

const UBUNTU = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
`
const DEBIAN = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\n`

function deps(files: Record<string, string>, overrides: Partial<NodeSystemDetailsDeps> = {}) {
  return {
    os: {
      platform: () => "linux",
      release: () => "6.8.0-51-generic",
      version: () => "#52-Ubuntu SMP PREEMPT_DYNAMIC",
      arch: () => "x64",
      hostname: () => "3f2a9c1b7e44",
      cpus: () =>
        Array.from({ length: 4 }, () => ({ model: " Intel(R) Xeon(R) Platinum 8255C  " })) as never,
      totalmem: () => 8_000,
      freemem: () => 3_000,
    },
    readText: async (path: string) => {
      if (path in files) return files[path]
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
    },
    env: { NODE_ENV: "production" },
    ...overrides,
  } satisfies NodeSystemDetailsDeps
}

describe("parseOsRelease", () => {
  it("splits NAME and VERSION like the Rust host, else PRETTY_NAME, else nothing", () => {
    expect(parseOsRelease(UBUNTU)).toEqual({
      name: "Ubuntu",
      version: "24.04.1 LTS (Noble Numbat)",
    })
    expect(parseOsRelease(`NAME='Alpine Linux'\nVERSION_ID=3.20`)).toEqual({
      name: "Alpine Linux",
      version: "3.20",
    })
    expect(parseOsRelease("NAME=Arch")).toEqual({ name: "Arch", version: null })
    expect(parseOsRelease('PRETTY_NAME="Custom OS"')).toEqual({ name: "Custom OS", version: null })
    expect(parseOsRelease("# empty\n")).toBeNull()
  })
})

describe("gatherNodeSystemDetails", () => {
  it("reports the Host's distribution and name when a container is handed them", async () => {
    const details = await gatherNodeSystemDetails(
      deps({
        "/run/host/os-release": UBUNTU,
        "/etc/os-release": DEBIAN,
        "/run/host/hostname": "VM-0-12-ubuntu\n",
      })
    )
    expect(details).toMatchObject({
      os: "Ubuntu",
      osVersion: "24.04.1 LTS (Noble Numbat)",
      kernelVersion: "6.8.0-51-generic",
      arch: "x64",
      hostname: "VM-0-12-ubuntu",
      cpu: "Intel(R) Xeon(R) Platinum 8255C",
      cpuCount: 4,
      totalMemoryBytes: 8_000,
      usedMemoryBytes: 5_000,
      family: "node",
      profile: "production",
    })
  })

  it("falls back to its own os-release, then the platform, and to its own hostname", async () => {
    // An empty file is what a container gets when nothing was mounted.
    const own = await gatherNodeSystemDetails(
      deps({ "/run/host/os-release": "", "/etc/os-release": DEBIAN, "/run/host/hostname": "" })
    )
    expect(own.os).toBe("Debian GNU/Linux")
    expect(own.hostname).toBe("3f2a9c1b7e44")

    const bare = await gatherNodeSystemDetails(deps({}))
    expect(bare).toMatchObject({ os: "linux", osVersion: null, kernelVersion: "6.8.0-51-generic" })
    expect(bare.appVersion).toBe("unknown")
  })

  it("leaves the processor unnamed when Node reports none", async () => {
    const details = await gatherNodeSystemDetails(
      deps({}, { os: { ...deps({}).os, cpus: () => [] as never } })
    )
    expect(details.cpu).toBeNull()
    expect(details.cpuCount).toBe(0)
  })
})
