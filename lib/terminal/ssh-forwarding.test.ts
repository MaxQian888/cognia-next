/**
 * Tests for SSH jump host and port forwarding extensions.
 */

import {
  validateLocalForward,
  validateRemoteForward,
  formatLocalForward,
  formatRemoteForward,
  buildLocalForwardFlag,
  buildRemoteForwardFlag,
  resolveJumpChain,
  buildProxyJumpFlag,
  type LocalForward,
  type RemoteForward,
  type SshExtendedProfile,
} from "./ssh-forwarding"

function makeProfile(id: string, overrides?: Partial<SshExtendedProfile>): SshExtendedProfile {
  return {
    id,
    name: `Host ${id}`,
    host: `${id}.example.com`,
    port: 22,
    username: "user",
    authMethod: "password",
    jumpHostId: null,
    localForwards: [],
    remoteForwards: [],
    ...overrides,
  }
}

describe("ssh-forwarding", () => {
  describe("validateLocalForward", () => {
    it("returns null for valid forward", () => {
      const fwd: LocalForward = { localPort: 8080, remoteHost: "db.internal", remotePort: 5432 }
      expect(validateLocalForward(fwd)).toBeNull()
    })

    it("rejects port below 1", () => {
      expect(validateLocalForward({ localPort: 0, remoteHost: "h", remotePort: 80 })).toBe(
        "port_out_of_range"
      )
    })

    it("rejects port above 65535", () => {
      expect(validateLocalForward({ localPort: 8080, remoteHost: "h", remotePort: 70000 })).toBe(
        "port_out_of_range"
      )
    })

    it("rejects empty remote host", () => {
      expect(validateLocalForward({ localPort: 8080, remoteHost: "", remotePort: 80 })).toBe(
        "host_empty"
      )
    })

    it("rejects duplicate local port", () => {
      const fwd: LocalForward = { localPort: 8080, remoteHost: "h", remotePort: 80 }
      expect(validateLocalForward(fwd, [8080, 3000])).toBe("duplicate_local_port")
    })

    it("allows non-duplicate local port", () => {
      const fwd: LocalForward = { localPort: 9090, remoteHost: "h", remotePort: 80 }
      expect(validateLocalForward(fwd, [8080, 3000])).toBeNull()
    })
  })

  describe("validateRemoteForward", () => {
    it("returns null for valid forward", () => {
      const fwd: RemoteForward = { remotePort: 9090, localHost: "localhost", localPort: 3000 }
      expect(validateRemoteForward(fwd)).toBeNull()
    })

    it("rejects port out of range", () => {
      expect(
        validateRemoteForward({ remotePort: -1, localHost: "localhost", localPort: 3000 })
      ).toBe("port_out_of_range")
    })

    it("rejects empty local host", () => {
      expect(validateRemoteForward({ remotePort: 9090, localHost: "  ", localPort: 3000 })).toBe(
        "host_empty"
      )
    })
  })

  describe("formatLocalForward", () => {
    it("formats standard forward", () => {
      expect(
        formatLocalForward({ localPort: 8080, remoteHost: "db.internal", remotePort: 5432 })
      ).toBe("8080 → db.internal:5432")
    })

    it("includes bind address when non-default", () => {
      expect(
        formatLocalForward({
          localPort: 8080,
          remoteHost: "db",
          remotePort: 5432,
          bindAddress: "0.0.0.0",
        })
      ).toBe("0.0.0.0:8080 → db:5432")
    })

    it("omits bind address when 127.0.0.1", () => {
      expect(
        formatLocalForward({
          localPort: 3000,
          remoteHost: "app",
          remotePort: 80,
          bindAddress: "127.0.0.1",
        })
      ).toBe("3000 → app:80")
    })
  })

  describe("formatRemoteForward", () => {
    it("formats standard forward", () => {
      expect(
        formatRemoteForward({ remotePort: 9090, localHost: "localhost", localPort: 3000 })
      ).toBe("9090 → localhost:3000")
    })
  })

  describe("buildLocalForwardFlag", () => {
    it("builds correct -L flag", () => {
      expect(buildLocalForwardFlag({ localPort: 8080, remoteHost: "db", remotePort: 5432 })).toBe(
        "-L 127.0.0.1:8080:db:5432"
      )
    })

    it("uses custom bind address", () => {
      expect(
        buildLocalForwardFlag({
          localPort: 8080,
          remoteHost: "db",
          remotePort: 5432,
          bindAddress: "0.0.0.0",
        })
      ).toBe("-L 0.0.0.0:8080:db:5432")
    })
  })

  describe("buildRemoteForwardFlag", () => {
    it("builds correct -R flag", () => {
      expect(
        buildRemoteForwardFlag({ remotePort: 9090, localHost: "localhost", localPort: 3000 })
      ).toBe("-R 127.0.0.1:9090:localhost:3000")
    })
  })

  describe("resolveJumpChain", () => {
    it("returns single-element chain for direct connection", () => {
      const target = makeProfile("target")
      const chain = resolveJumpChain(target, [target])
      expect(chain).toEqual([target])
    })

    it("resolves a single jump host", () => {
      const jump = makeProfile("jump")
      const target = makeProfile("target", { jumpHostId: "jump" })
      const chain = resolveJumpChain(target, [jump, target])

      expect(chain).toHaveLength(2)
      expect(chain![0].id).toBe("jump")
      expect(chain![1].id).toBe("target")
    })

    it("resolves multi-hop chain", () => {
      const bastion = makeProfile("bastion")
      const middle = makeProfile("middle", { jumpHostId: "bastion" })
      const target = makeProfile("target", { jumpHostId: "middle" })
      const all = [bastion, middle, target]

      const chain = resolveJumpChain(target, all)
      expect(chain).toHaveLength(3)
      expect(chain!.map((p) => p.id)).toEqual(["bastion", "middle", "target"])
    })

    it("returns null for broken chain (missing jump host)", () => {
      const target = makeProfile("target", { jumpHostId: "missing" })
      expect(resolveJumpChain(target, [target])).toBeNull()
    })

    it("returns null for circular reference", () => {
      const a = makeProfile("a", { jumpHostId: "b" })
      const b = makeProfile("b", { jumpHostId: "a" })
      expect(resolveJumpChain(a, [a, b])).toBeNull()
    })

    it("returns null when chain exceeds max depth", () => {
      const profiles: SshExtendedProfile[] = []
      for (let i = 0; i < 7; i++) {
        profiles.push(makeProfile(`host-${i}`, { jumpHostId: i > 0 ? `host-${i - 1}` : null }))
      }
      const target = makeProfile("target", { jumpHostId: "host-6" })
      profiles.push(target)

      // maxDepth=5 means 5 jumps max
      expect(resolveJumpChain(target, profiles, 5)).toBeNull()
    })
  })

  describe("buildProxyJumpFlag", () => {
    it("returns empty for no jump hosts", () => {
      expect(buildProxyJumpFlag([])).toBe("")
    })

    it("builds single jump", () => {
      expect(
        buildProxyJumpFlag([{ username: "admin", host: "bastion.example.com", port: 22 }])
      ).toBe("-J admin@bastion.example.com")
    })

    it("includes non-standard port", () => {
      expect(
        buildProxyJumpFlag([{ username: "admin", host: "bastion.example.com", port: 2222 }])
      ).toBe("-J admin@bastion.example.com:2222")
    })

    it("builds multi-hop jump", () => {
      expect(
        buildProxyJumpFlag([
          { username: "user1", host: "hop1.com", port: 22 },
          { username: "user2", host: "hop2.com", port: 443 },
        ])
      ).toBe("-J user1@hop1.com,user2@hop2.com:443")
    })
  })
})
