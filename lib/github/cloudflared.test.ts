import {
  parseTrycloudflareUrl,
  startTunnel,
  type CloudflaredProcess,
} from "./cloudflared"

function fakeProcess(opts: {
  stdoutLines?: string[]
  stderrLines?: string[]
  exitCode?: number
  delayBetweenLinesMs?: number
}): CloudflaredProcess {
  const exitCode = opts.exitCode ?? 0
  let killed = false
  const stdout = opts.stdoutLines ?? []
  const stderr = opts.stderrLines ?? []

  async function* drain(arr: string[]): AsyncIterable<string> {
    for (const line of arr) {
      if (killed) return
      if (opts.delayBetweenLinesMs) await new Promise((r) => setTimeout(r, opts.delayBetweenLinesMs))
      yield line
    }
  }

  return {
    stdoutLines: () => drain(stdout),
    stderrLines: () => drain(stderr),
    waitForExit: async () => {
      // Wait for both iterators to complete by giving the event loop a tick.
      await new Promise((r) => setTimeout(r, opts.delayBetweenLinesMs ?? 0))
      return exitCode
    },
    kill: async () => {
      killed = true
    },
  }
}

describe("parseTrycloudflareUrl", () => {
  it("extracts the URL from a typical cloudflared startup line", () => {
    expect(
      parseTrycloudflareUrl(
        "2026-05-12T10:00:00Z INF |  https://random-words-1234.trycloudflare.com  |"
      )
    ).toBe("https://random-words-1234.trycloudflare.com")
  })

  it("returns null when the line has no URL", () => {
    expect(parseTrycloudflareUrl("INF starting tunnel")).toBeNull()
  })

  it("is case-insensitive", () => {
    expect(parseTrycloudflareUrl("HTTPS://FOO.TRYCLOUDFLARE.COM is up")).toMatch(/foo/i)
  })
})

describe("startTunnel", () => {
  it("returns the fixedUrl when provided (no spawn invoked)", async () => {
    const spawn = jest.fn()
    const handle = await startTunnel({
      localPort: 1234,
      spawn,
      fixedUrl: "https://fixture.trycloudflare.com",
    })
    expect(handle.publicUrl).toBe("https://fixture.trycloudflare.com")
    expect(spawn).not.toHaveBeenCalled()
    await handle.stop()
  })

  it("rejects when no spawn impl is provided", async () => {
    await expect(startTunnel({ localPort: 1234 })).rejects.toThrow(/spawn implementation/)
  })

  it("resolves with the URL printed on stdout", async () => {
    const proc = fakeProcess({
      stdoutLines: ["INF starting…", "https://foo-bar.trycloudflare.com is your URL"],
    })
    const handle = await startTunnel({
      localPort: 1234,
      spawn: async () => proc,
    })
    expect(handle.publicUrl).toBe("https://foo-bar.trycloudflare.com")
    await handle.stop()
  })

  it("resolves with the URL printed on stderr (cloudflared often logs there)", async () => {
    const proc = fakeProcess({
      stderrLines: ["INF: tunnel registered at https://bar.trycloudflare.com"],
    })
    const handle = await startTunnel({
      localPort: 1234,
      spawn: async () => proc,
    })
    expect(handle.publicUrl).toBe("https://bar.trycloudflare.com")
  })

  it("rejects when process exits without printing a URL", async () => {
    const proc = fakeProcess({ stdoutLines: ["INF starting…"], exitCode: 1 })
    await expect(
      startTunnel({ localPort: 1234, spawn: async () => proc })
    ).rejects.toThrow(/exited|without printing a tunnel URL/)
  })

  it("rejects after waitMs deadline when nothing prints", async () => {
    // Process that never exits and prints nothing — use a never-yielding iter.
    const neverEnding: CloudflaredProcess = {
      stdoutLines: async function* () {
        await new Promise(() => {})
      },
      stderrLines: async function* () {
        await new Promise(() => {})
      },
      waitForExit: () => new Promise(() => 0),
      kill: async () => {},
    }
    await expect(
      startTunnel({ localPort: 1234, spawn: async () => neverEnding, waitMs: 20 })
    ).rejects.toThrow(/no URL after 20ms/)
  })

  it("handle.stop() kills the underlying process", async () => {
    const proc = fakeProcess({
      stderrLines: ["https://kill-me.trycloudflare.com"],
    })
    const killSpy = jest.spyOn(proc, "kill")
    const handle = await startTunnel({
      localPort: 1234,
      spawn: async () => proc,
    })
    await handle.stop()
    expect(killSpy).toHaveBeenCalled()
  })
})
