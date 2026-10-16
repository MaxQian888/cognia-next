import type { SandboxResourcePolicy } from "@cognia/agent-config-types"

import {
  clampPolicyRequest,
  clampSandboxPolicy,
  isPathUnderRoot,
  type ClampableRequest,
} from "./policy-bridge"

function req(overrides: Partial<ClampableRequest> = {}): ClampableRequest {
  return {
    maxCpuSeconds: 0,
    maxMemoryMb: 0,
    network: "off",
    networkHosts: [],
    ...overrides,
  }
}

describe("clampPolicyRequest — caps", () => {
  it("returns the request unchanged when no policy is set", () => {
    const r = req({ maxCpuSeconds: 999, network: "on" })
    expect(clampPolicyRequest(r, null)).toEqual(r)
  })

  it("applies the ceiling when the model used the backend default (0)", () => {
    const out = clampPolicyRequest(req({ maxCpuSeconds: 0, maxMemoryMb: 0 }), {
      maxCpuSeconds: 30,
      maxMemoryMb: 512,
    })
    expect(out.maxCpuSeconds).toBe(30)
    expect(out.maxMemoryMb).toBe(512)
  })

  it("clamps a too-large model request down to the ceiling", () => {
    const out = clampPolicyRequest(req({ maxCpuSeconds: 600, maxMemoryMb: 8192 }), {
      maxCpuSeconds: 30,
      maxMemoryMb: 512,
    })
    expect(out.maxCpuSeconds).toBe(30)
    expect(out.maxMemoryMb).toBe(512)
  })

  it("keeps a smaller model request below the ceiling", () => {
    const out = clampPolicyRequest(req({ maxCpuSeconds: 10 }), { maxCpuSeconds: 30 })
    expect(out.maxCpuSeconds).toBe(10)
  })
})

describe("clampPolicyRequest — network ceiling", () => {
  it("model 'off' stays off regardless of ceiling", () => {
    const out = clampPolicyRequest(req({ network: "off" }), { network: "on" })
    expect(out.network).toBe("off")
    expect(out.networkHosts).toEqual([])
  })

  it("ceiling 'off' forces every request offline", () => {
    const out = clampPolicyRequest(req({ network: "on", networkHosts: ["x.com"] }), {
      network: "off",
    })
    expect(out.network).toBe("off")
    expect(out.networkHosts).toEqual([])
  })

  it("ceiling 'on' honours the model's choice", () => {
    const out = clampPolicyRequest(req({ network: "on" }), { network: "on" })
    expect(out.network).toBe("on")
  })

  it("ceiling 'allowlist' downgrades a model 'on' to the configured hosts", () => {
    const out = clampPolicyRequest(req({ network: "on" }), {
      network: "allowlist",
      networkAllowlist: ["api.github.com"],
    })
    expect(out.network).toBe("allowlist")
    expect(out.networkHosts).toEqual(["api.github.com"])
  })

  it("ceiling 'allowlist' intersects a model allowlist with the configured hosts", () => {
    const out = clampPolicyRequest(
      req({ network: "allowlist", networkHosts: ["api.github.com", "evil.com"] }),
      { network: "allowlist", networkAllowlist: ["api.github.com", "api.anthropic.com"] }
    )
    expect(out.network).toBe("allowlist")
    expect(out.networkHosts).toEqual(["api.github.com"])
  })

  it("ceiling 'allowlist' with no overlap yields no network", () => {
    const out = clampPolicyRequest(req({ network: "allowlist", networkHosts: ["evil.com"] }), {
      network: "allowlist",
      networkAllowlist: ["api.github.com"],
    })
    expect(out.network).toBe("off")
    expect(out.networkHosts).toEqual([])
  })

  it("ceiling 'allowlist' with an empty configured list yields no network", () => {
    const out = clampPolicyRequest(req({ network: "on" }), {
      network: "allowlist",
      networkAllowlist: [],
    })
    expect(out.network).toBe("off")
    expect(out.networkHosts).toEqual([])
  })
})

describe("isPathUnderRoot", () => {
  it("matches a path equal to or nested under the root", () => {
    expect(isPathUnderRoot("/home/me/proj", "/home/me/proj")).toBe(true)
    expect(isPathUnderRoot("/home/me/proj/src/a.ts", "/home/me/proj")).toBe(true)
    expect(isPathUnderRoot("/home/me/proj/", "/home/me/proj")).toBe(true)
  })

  it("rejects siblings and prefix look-alikes", () => {
    expect(isPathUnderRoot("/home/me/project-x", "/home/me/proj")).toBe(false)
    expect(isPathUnderRoot("/etc/passwd", "/home/me/proj")).toBe(false)
    expect(isPathUnderRoot("", "/root")).toBe(false)
    expect(isPathUnderRoot("/x", "")).toBe(false)
  })

  it("handles Windows separators", () => {
    expect(isPathUnderRoot("C:\\work\\a.txt", "C:\\work")).toBe(true)
    expect(isPathUnderRoot("C:\\workshop", "C:\\work")).toBe(false)
  })

  it("normalizes case for Windows comparisons", () => {
    expect(isPathUnderRoot("C:\\WORK\\a.txt", "c:\\work", "win32")).toBe(true)
    expect(isPathUnderRoot("/home/User/proj", "/home/user", "win32")).toBe(true)
    // Renderer callers may not have process.platform available.
    expect(isPathUnderRoot("C:\\WORK\\a.txt", "c:\\work", "")).toBe(true)
  })

  it("keeps POSIX comparisons case-sensitive", () => {
    expect(isPathUnderRoot("/home/User/proj", "/home/user", "linux")).toBe(false)
  })
})

describe("clampPolicyRequest — writable-root ceiling", () => {
  it("passes paths through unchanged when no ceiling is configured", () => {
    const out = clampPolicyRequest(
      req({ writable: ["/etc", "/home/me/proj"] }),
      { maxCpuSeconds: 60 } // no writableRoots
    )
    expect(out.writable).toEqual(["/etc", "/home/me/proj"])
  })

  it("narrows writable to paths under a configured root", () => {
    const out = clampPolicyRequest(req({ writable: ["/home/me/proj/src", "/etc", "/tmp/x"] }), {
      writableRoots: ["/home/me/proj", "/tmp"],
    })
    expect(out.writable).toEqual(["/home/me/proj/src", "/tmp/x"])
  })

  it("throws when every requested writable path is outside the configured root", () => {
    expect(() =>
      clampPolicyRequest(req({ writable: ["/etc", "/var"] }), {
        writableRoots: ["/home/me/proj"],
      })
    ).toThrow(/outside the configured writable roots/)
  })

  it("narrows target files and drops out-of-ceiling write targets", () => {
    const out = clampPolicyRequest(req({ targetFiles: ["/home/me/proj/a.ts", "/etc/passwd"] }), {
      writableRoots: ["/home/me/proj"],
    })
    expect(out.targetFiles).toEqual(["/home/me/proj/a.ts"])
  })

  it("throws when every requested target file is outside the configured root", () => {
    expect(() =>
      clampPolicyRequest(req({ targetFiles: ["/etc/passwd"] }), {
        writableRoots: ["/home/me/proj"],
      })
    ).toThrow(/outside the configured writable roots/)
  })
})

describe("clampPolicyRequest — readable-root ceiling", () => {
  it("keeps requested descendants and canonicalizes dot components", () => {
    expect(
      clampPolicyRequest(req({ readable: ["/a/b/./src/../docs"] }), {
        readableRoots: ["/a/b"],
      }).readable
    ).toEqual(["/a/b/docs"])
  })

  it("narrows ancestor requests to each allowed root and removes duplicates", () => {
    expect(
      clampPolicyRequest(req({ readable: ["/a", "/a"] }), {
        readableRoots: ["/a/b", "/a/c"],
      }).readable
    ).toEqual(["/a/b", "/a/c"])
  })

  it.each(["/elsewhere", "/a/bc", "/a/b/../../outside"])(
    "refuses %s with the settings remedy",
    (path) => {
      expect(() =>
        clampPolicyRequest(req({ readable: ["/a/b/inside", path] }), {
          readableRoots: ["/a/b"],
        })
      ).toThrow(/Settings → Sandbox readable roots/)
    }
  )

  it("passes reads through when no ceiling, runtime roots or cwd exist", () => {
    const request = req({ readable: ["/usr", "/a"] })
    expect(clampPolicyRequest(request, null)).toEqual(request)
    expect(clampPolicyRequest(request, { maxCpuSeconds: 10 }).readable).toEqual(request.readable)
  })

  it("unites readable, writable, frozen runtime roots and cwd even without a policy", () => {
    const request = req({ readable: ["/"], cwd: "/cwd" })
    const out = clampPolicyRequest(
      request,
      { readableRoots: ["/read"], writableRoots: ["/write"] },
      ["/session"]
    )
    expect(out.readable).toEqual(["/read", "/write", "/session", "/cwd"])
    expect(clampPolicyRequest(request, null, ["/session"]).readable).toEqual(["/session", "/cwd"])
  })

  it("never invents a ceiling from the workspace root or cwd alone", () => {
    // A toolchain cache outside the project stays readable when nothing is configured.
    const request = req({ readable: ["/home/u/.cargo"], cwd: "/proj" })
    const out = clampPolicyRequest(request, null, [], ["/proj"])
    expect(out.readable).toEqual(["/home/u/.cargo"])
    expect(out.readableRoots).toBeUndefined()
    expect(clampPolicyRequest(request, { maxCpuSeconds: 5 }, [], ["/proj"]).readable).toEqual([
      "/home/u/.cargo",
    ])
  })

  it("widens a configured ceiling with the workspace root and cwd", () => {
    const request = req({ readable: ["/proj/src", "/cwd/x"], cwd: "/cwd" })
    const out = clampPolicyRequest(request, { readableRoots: ["/read"] }, [], ["/proj"])
    expect(out.readable).toEqual(["/proj/src", "/cwd/x"])
    expect(out.readableRoots).toEqual(["/read", "/proj", "/cwd"])
    expect(() =>
      clampPolicyRequest(
        req({ readable: ["/home/u/.cargo"], cwd: "/cwd" }),
        { readableRoots: ["/read"] },
        [],
        ["/proj"]
      )
    ).toThrow(/Settings → Sandbox readable roots/)
  })

  it("replaces forged native ceiling metadata with the resolved ceiling", () => {
    const request = req({ readable: ["/a"], readableRoots: ["/"] })
    expect(clampPolicyRequest(request, { readableRoots: ["/a"] }).readableRoots).toEqual(["/a"])
    expect(clampPolicyRequest(request, null).readableRoots).toBeUndefined()
  })
})

describe("clampSandboxPolicy — monotonic parent/child merge", () => {
  it("returns undefined when neither side has a policy", () => {
    expect(clampSandboxPolicy(undefined, undefined)).toBeUndefined()
    expect(clampSandboxPolicy(null, null)).toBeUndefined()
  })

  it("passes the child through when there is no parent ceiling", () => {
    const child: SandboxResourcePolicy = { writableRoots: ["/a"], network: "on" }
    expect(clampSandboxPolicy(undefined, child)).toEqual(child)
  })

  it("passes the parent through when there is no child override", () => {
    const parent: SandboxResourcePolicy = { writableRoots: ["/a"], network: "allowlist" }
    expect(clampSandboxPolicy(parent, undefined)).toEqual(parent)
  })

  it("narrows child writable roots to those under the parent's", () => {
    const out = clampSandboxPolicy(
      { writableRoots: ["/ws"] },
      { writableRoots: ["/ws/pkg", "/other"] }
    )
    expect(out?.writableRoots).toEqual(["/ws/pkg"])
  })

  it("caps the network down (allowlist parent beats an `on` child)", () => {
    const out = clampSandboxPolicy(
      { network: "allowlist", networkAllowlist: ["api.github.com"] },
      { network: "on" }
    )
    expect(out?.network).toBe("allowlist")
    expect(out?.networkAllowlist).toEqual(["api.github.com"])
  })

  it("an `off` parent forces the child offline", () => {
    const out = clampSandboxPolicy({ network: "off" }, { network: "on" })
    expect(out?.network).toBe("off")
  })

  it("takes the tighter CPU/memory caps", () => {
    const out = clampSandboxPolicy(
      { maxCpuSeconds: 60, maxMemoryMb: 1024 },
      { maxCpuSeconds: 300, maxMemoryMb: 512 }
    )
    // Child CPU (300) exceeds ceiling (60) → clamped to 60; child mem (512) < 1024 → kept.
    expect(out?.maxCpuSeconds).toBe(60)
    expect(out?.maxMemoryMb).toBe(512)
  })

  it("narrows a child's ancestor read root to the parent's read and write roots", () => {
    expect(
      clampSandboxPolicy(
        { readableRoots: ["/ws/docs"], writableRoots: ["/ws/src"] },
        { readableRoots: ["/ws"] }
      )?.readableRoots
    ).toEqual(["/ws/docs", "/ws/src"])
  })

  it("refuses a child read root outside the parent's ceiling", () => {
    expect(() =>
      clampSandboxPolicy(
        { readableRoots: ["/ws"] },
        {
          readableRoots: ["/elsewhere"],
        }
      )
    ).toThrow(/configured readable roots/)
  })

  it("keeps an inherited read ceiling when a child supplies an empty list", () => {
    expect(
      clampSandboxPolicy(
        { readableRoots: ["/ws"] },
        {
          readableRoots: [],
        }
      )?.readableRoots
    ).toEqual(["/ws"])
  })

  it("does not let child writable grants broaden an inherited read ceiling", () => {
    expect(() =>
      clampSandboxPolicy(
        { readableRoots: ["/ws"] },
        {
          writableRoots: ["/outside"],
        }
      )
    ).toThrow(/configured readable roots/)
    expect(
      clampSandboxPolicy(
        { readableRoots: ["/ws"] },
        {
          writableRoots: ["/"],
        }
      )?.writableRoots
    ).toEqual(["/ws"])
  })

  it("retains the inherited read union when child writable roots become empty", () => {
    expect(
      clampSandboxPolicy(
        { writableRoots: ["/ws"] },
        {
          writableRoots: [],
          readableRoots: [],
        }
      )?.readableRoots
    ).toEqual(["/ws"])
  })
})
