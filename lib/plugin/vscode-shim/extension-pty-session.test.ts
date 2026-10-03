import { ExtensionPtySession } from "./extension-pty-session"

function setup() {
  const calls = { input: [] as string[], resize: [] as Array<[number, number]>, kills: 0 }
  const session = new ExtensionPtySession(
    { extensionId: "acme.ext", name: "Build", projectId: "p1" },
    {
      onInput: (data) => calls.input.push(data),
      onResize: (columns, rows) => calls.resize.push([columns, rows]),
      onKill: () => {
        calls.kills += 1
      },
    }
  )
  return { session, calls }
}

const text = (chunks: Uint8Array[]) =>
  chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")

it("is an extension tab named for the terminal, owned by its extension", () => {
  const { session } = setup()
  expect(session.info).toMatchObject({
    projectId: "p1",
    extensionId: "acme.ext",
    shell: "Build",
    kind: "extension",
    origin: "local",
    alive: true,
  })
  expect(session.id).toMatch(/^vscode-pty-/)
})

it("shows what the extension writes, keeping it until the tab listens", () => {
  const { session } = setup()
  session.push("hello\r\n")
  const seen: Uint8Array[] = []
  session.onData((bytes) => seen.push(bytes))
  session.push("again")
  session.push("")
  expect(text(seen)).toBe("hello\r\nagain")
  expect(session.getLastOutput()).toBe("hello\r\nagain")
})

it("hands the extension what the user types and each new size once", async () => {
  const { session, calls } = setup()
  await session.write("ls")
  await session.write(new TextEncoder().encode("\r"))
  await session.write("")
  await session.resize(30, 100)
  await session.resize(30, 100)
  await session.resize(31, 100)
  expect(calls.input).toEqual(["ls", "\r"])
  expect(calls.resize).toEqual([
    [100, 30],
    [100, 31],
  ])
})

it("ends with the extension's code, after which nothing flows", async () => {
  const { session, calls } = setup()
  const exits: Array<number | null> = []
  session.onExit((code) => exits.push(code))
  session.finish(3)
  session.finish(4)
  await session.write("x")
  await session.kill()
  const seen: Uint8Array[] = []
  session.onData((bytes) => seen.push(bytes))
  session.push("late")
  expect(exits).toEqual([3])
  expect(session.info.alive).toBe(false)
  expect(calls.input).toEqual([])
  expect(calls.kills).toBe(0)
  expect(seen).toEqual([])
})

it("closing the tab tells the extension once, as does detaching", async () => {
  const closed = setup()
  const exits: Array<number | null> = []
  closed.session.onExit((code) => exits.push(code))
  await closed.session.kill()
  await closed.session.kill()
  expect(closed.calls.kills).toBe(1)
  expect(exits).toEqual([null])

  const detached = setup()
  await detached.session.detach()
  expect(detached.calls.kills).toBe(1)
  expect(detached.session.isExited).toBe(true)
})

it("has no controller lease to take or give", async () => {
  const { session } = setup()
  await expect(session.takeControl()).rejects.toThrow(/controller leases/)
  await expect(session.releaseControl()).rejects.toThrow(/controller leases/)
})
