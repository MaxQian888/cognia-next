import osShim from "./os-shim.js"

describe("os browser shim", () => {
  it("exposes the eval-time probes that deps like @vercel/oidc read", () => {
    // These three are the concrete crash trigger: a module-level User-Agent
    // constant. They must be callable and return strings, not throw.
    expect(osShim.platform()).toBe("browser")
    expect(typeof osShim.arch()).toBe("string")
    expect(typeof osShim.hostname()).toBe("string")
  })

  it("returns inert values for the remaining os surface", () => {
    expect(osShim.EOL).toBe("\n")
    expect(osShim.type()).toBe("Browser")
    expect(osShim.endianness()).toBe("LE")
    expect(osShim.homedir()).toBe("/")
    expect(osShim.tmpdir()).toBe("/tmp")
    expect(osShim.devNull).toBe("/dev/null")
    expect(osShim.constants).toEqual({})
    expect(osShim.release()).toBe("")
    expect(osShim.version()).toBe("")
    expect(osShim.machine()).toBe("")
    expect(osShim.availableParallelism()).toBe(1)
    expect(osShim.cpus()).toEqual([])
    expect(osShim.loadavg()).toEqual([0, 0, 0])
    expect(osShim.totalmem()).toBe(0)
    expect(osShim.freemem()).toBe(0)
    expect(osShim.uptime()).toBe(0)
    expect(osShim.networkInterfaces()).toEqual({})
    expect(osShim.userInfo()).toEqual({
      username: "",
      uid: -1,
      gid: -1,
      shell: null,
      homedir: "/",
    })
    expect(osShim.getPriority()).toBe(0)
    expect(osShim.setPriority()).toBeUndefined()
  })
})
