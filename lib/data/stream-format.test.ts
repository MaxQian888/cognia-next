function pages(...values: Array<{ section: string; rows: unknown[] }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value
    },
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  return collect(source)
}

async function* bytes(chunks: Uint8Array[]) {
  for (const chunk of chunks) yield chunk
}

const manifest = {
  traceId: "trace-1",
  exportedAt: "2026-08-06T00:00:00.000Z",
  appVersion: "0.1.0",
  backend: "web-dexie" as const,
  sourceSchemaVersion: 150,
}

describe("backup stream v4", () => {
  it("does not pull the next database page until the consumer requests it", async () => {
    const { createBackupStream } = await import("./stream-format")
    let pulled = 0
    const sections = {
      async *[Symbol.asyncIterator]() {
        pulled += 1
        yield { section: "messages", rows: [{ id: 1 }] }
        pulled += 1
        yield { section: "messages", rows: [{ id: 2 }] }
      },
    }
    const iterator = createBackupStream({ manifest, sections })[Symbol.asyncIterator]()

    await iterator.next() // header
    expect(pulled).toBe(0)
    await iterator.next() // first data page
    expect(pulled).toBe(1)
    await iterator.return?.()
    expect(pulled).toBe(1)
  })

  it("round-trips ordered pages without aggregating them into one payload", async () => {
    const { createBackupStream, readBackupStream } = await import("./stream-format")
    const bytes = createBackupStream({
      manifest,
      sections: pages(
        { section: "characters", rows: [{ id: "c1" }, { id: "c2" }] },
        { section: "characters", rows: [{ id: "c3" }] },
        { section: "messages", rows: [] }
      ),
    })

    await expect(collect(readBackupStream(bytes))).resolves.toEqual([
      expect.objectContaining({ kind: "header", version: "4.0", manifest }),
      { kind: "chunk", sequence: 0, section: "characters", rows: [{ id: "c1" }, { id: "c2" }] },
      { kind: "chunk", sequence: 1, section: "characters", rows: [{ id: "c3" }] },
      { kind: "chunk", sequence: 2, section: "messages", rows: [] },
      {
        kind: "footer",
        sequence: 3,
        chunkCount: 3,
        rowCount: 3,
        sectionCounts: { characters: 3, messages: 0 },
      },
    ])
  })

  it("encrypts every data record independently and authenticates the passphrase", async () => {
    const { createBackupStream, readBackupStream } = await import("./stream-format")
    const encoded = await collectBytes(
      createBackupStream({
        manifest,
        sections: pages({ section: "settings", rows: [{ apiKey: "must-not-leak" }] }),
        encryption: { passphrase: "correct horse battery staple" },
      })
    )
    const raw = new TextDecoder().decode(
      encoded.reduce((all, chunk) => {
        const next = new Uint8Array(all.length + chunk.length)
        next.set(all)
        next.set(chunk, all.length)
        return next
      }, new Uint8Array())
    )

    expect(raw).not.toContain("must-not-leak")
    await expect(
      collect(readBackupStream(bytes(encoded), { passphrase: "correct horse battery staple" }))
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "header",
        encryption: expect.objectContaining({ enabled: true }),
      }),
      { kind: "chunk", sequence: 0, section: "settings", rows: [{ apiKey: "must-not-leak" }] },
      expect.objectContaining({ kind: "footer", chunkCount: 1, rowCount: 1 }),
    ])
    await expect(
      collect(readBackupStream(bytes(encoded), { passphrase: "wrong" }))
    ).rejects.toThrow()
  })

  it("splits oversized input pages and rejects truncated streams", async () => {
    const { createBackupStream, readBackupStream } = await import("./stream-format")
    const encoded = await collectBytes(
      createBackupStream({
        manifest,
        sections: pages({
          section: "messages",
          rows: Array.from({ length: 8 }, (_, id) => ({ id, text: "x".repeat(24) })),
        }),
        maxChunkBytes: 160,
      })
    )
    const events = await collect(readBackupStream(bytes(encoded)))
    const chunks = events.filter((event) => event.kind === "chunk")

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flatMap((chunk) => chunk.rows)).toHaveLength(8)
    await expect(collect(readBackupStream(bytes(encoded.slice(0, -1))))).rejects.toThrow(
      /footer is missing/
    )
  })

  it("rejects tampered plaintext chunks before yielding their rows", async () => {
    const { createBackupStream, readBackupStream } = await import("./stream-format")
    const encoded = await collectBytes(
      createBackupStream({
        manifest,
        sections: pages({ section: "characters", rows: [{ id: "original" }] }),
      })
    )
    const chunk = JSON.parse(new TextDecoder().decode(encoded[1]))
    chunk.rows[0].id = "tampered"
    encoded[1] = new TextEncoder().encode(`${JSON.stringify(chunk)}\n`)

    await expect(collect(readBackupStream(bytes(encoded)))).rejects.toThrow(/checksum mismatch/)
  })
})
