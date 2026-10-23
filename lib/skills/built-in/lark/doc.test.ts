import { spawnSync } from "node:child_process"
import { fetchLarkDocAsRawSource } from "@/lib/twin/ingest/lark-doc-fetcher"
import { getSharedBuiltInSkillRegistry } from "../registry"
import { runLarkCli } from "./_helpers"
import "./doc"

jest.mock("./_helpers", () => ({
  ...jest.requireActual("./_helpers"),
  runLarkCli: jest.fn(),
}))

const runMock = runLarkCli as jest.Mock
const doc = "doxcnAuditToken123456"
function skill(verb: string) {
  return getSharedBuiltInSkillRegistry().get(`lark.doc.${verb}`)!
}
async function execute(verb: string, args: Record<string, unknown>) {
  const tool = skill(verb)
  return tool.execute(tool.inputSchema.parse({ docToken: doc, ...args }), {
    sessionId: "audit",
    humanConfirmed: true,
  })
}

beforeEach(() => runMock.mockReset())

it("registers the certified Lark Docs skill family", () => {
  const skills = getSharedBuiltInSkillRegistry().listByFamily("lark.doc")
  expect(skills).toHaveLength(6)
  expect(skills.every((skill) => skill.platforms.includes("lark"))).toBe(true)
})

describe("document edit contracts", () => {
  it("sends the requested Markdown format and revision without an unsupported --yes flag", async () => {
    await execute("update", {
      operation: "append",
      payload: "## Heading",
      format: "markdown",
      revisionId: 7,
    })
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: false,
        args: [
          "docs",
          "+update",
          "--doc",
          doc,
          "--command",
          "append",
          "--content",
          "## Heading",
          "--doc-format",
          "markdown",
          "--revision-id",
          "7",
        ],
      })
    )
  })

  it("forwards explicit desktop approval to a high-risk document deletion", async () => {
    await execute("delete", {})
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }))
  })

  it("does not invent CLI confirmation for an unapproved high-risk operation", async () => {
    const tool = skill("delete")
    await tool.execute(tool.inputSchema.parse({ docToken: doc }), { sessionId: "audit" })
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ confirmed: false }))
  })

  it("allows an empty replacement and keeps it as an argv value", async () => {
    await execute("update", { operation: "str_replace", payload: "", anchor: "remove me" })
    expect(runMock.mock.calls[0][0].args).toEqual([
      "docs",
      "+update",
      "--doc",
      doc,
      "--command",
      "str_replace",
      "--content",
      "",
      "--doc-format",
      "xml",
      "--pattern",
      "remove me",
    ])
  })

  it("deletes blocks without requiring or forwarding irrelevant content", async () => {
    await execute("update", {
      operation: "block_delete",
      anchor: "blk1,blk2",
      payload: "legacy filler",
    })
    expect(runMock.mock.calls[0][0].args).toEqual([
      "docs",
      "+update",
      "--doc",
      doc,
      "--command",
      "block_delete",
      "--block-id",
      "blk1,blk2",
    ])
    expect(
      skill("update").inputSchema.safeParse({
        docToken: doc,
        operation: "block_delete",
        anchor: "blk1",
      }).success
    ).toBe(true)
  })

  it.each(["block_move_after", "block_copy_insert_after"])(
    "supports %s with source blocks",
    async (operation) => {
      await execute("update", {
        operation,
        anchor: "blkTarget",
        sourceBlockIds: ["blk1", "blk2"],
        revisionId: 3,
      })
      expect(runMock.mock.calls[0][0].args).toEqual([
        "docs",
        "+update",
        "--doc",
        doc,
        "--command",
        operation,
        "--block-id",
        "blkTarget",
        "--src-block-ids",
        "blk1,blk2",
        "--revision-id",
        "3",
      ])
    }
  )

  it.each([
    { operation: "append" },
    { operation: "append", payload: "" },
    { operation: "overwrite", payload: "" },
    { operation: "str_replace", payload: "replacement" },
    { operation: "str_replace", payload: "", anchor: " " },
    { operation: "block_delete" },
    { operation: "block_replace", payload: "<p>new</p>" },
    { operation: "block_move_after", anchor: "blkTarget" },
    { operation: "block_copy_insert_after", anchor: "blkTarget", sourceBlockIds: [] },
    { operation: "append", payload: "body", revisionId: -2 },
  ])("rejects invalid operation-specific arguments: %j", (args) => {
    expect(skill("update").inputSchema.safeParse({ docToken: doc, ...args }).success).toBe(false)
  })

  it("retains DocxXML as the default body format", async () => {
    await execute("update", { operation: "block_replace", anchor: "blk1", payload: "<p>new</p>" })
    expect(runMock.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(["--doc-format", "xml", "--block-id", "blk1"])
    )
  })
})

describe("scoped document reads", () => {
  it("passes both range bounds, body format and revision", async () => {
    await execute("fetch", {
      mode: "range",
      startBlockId: "blkStart",
      endBlockId: "blkEnd",
      contentFormat: "markdown",
      revisionId: 12,
      format: "with-ids",
    })
    expect(runMock.mock.calls[0][0].args).toEqual([
      "docs",
      "+fetch",
      "--doc",
      doc,
      "--scope",
      "range",
      "--detail",
      "with-ids",
      "--start-block-id",
      "blkStart",
      "--end-block-id",
      "blkEnd",
      "--doc-format",
      "markdown",
      "--revision-id",
      "12",
    ])
  })

  it("keeps sectionId as a compatible start-block alias", async () => {
    await execute("fetch", { mode: "section", sectionId: "blkHeading" })
    expect(runMock.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(["--start-block-id", "blkHeading"])
    )
  })

  it.each([
    { mode: "range" },
    { mode: "section" },
    { mode: "keyword" },
    { mode: "keyword", keyword: " " },
    { mode: "range", sectionId: "a", startBlockId: "b" },
  ])("rejects missing or conflicting selectors: %j", (args) => {
    expect(skill("fetch").inputSchema.safeParse({ docToken: doc, ...args }).success).toBe(false)
  })

  it("accepts an end-only range", () => {
    expect(
      skill("fetch").inputSchema.safeParse({ docToken: doc, mode: "range", endBlockId: "blkEnd" })
        .success
    ).toBe(true)
  })
})

describe("image block anchoring", () => {
  const input = { imagePath: "/audit.png", anchorBlockId: "blkTarget" }

  it("checks the anchor, appends, then moves the newly created image by id", async () => {
    runMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ data: { block_id: "blkNew", file_token: "img" } })
      .mockResolvedValueOnce({ data: { result: "success" } })
    await execute("upload_image", input)
    expect(runMock.mock.calls.map(([call]) => call.args)).toEqual([
      [
        "docs",
        "+fetch",
        "--doc",
        doc,
        "--scope",
        "range",
        "--start-block-id",
        "blkTarget",
        "--end-block-id",
        "blkTarget",
      ],
      ["docs", "+media-insert", "--doc", doc, "--file", "/audit.png", "--type", "image"],
      [
        "docs",
        "+update",
        "--doc",
        doc,
        "--command",
        "block_move_after",
        "--block-id",
        "blkTarget",
        "--src-block-ids",
        "blkNew",
      ],
    ])
    expect(runMock.mock.calls.every(([call]) => call.confirmed === false)).toBe(true)
  })

  it("keeps a single append call when no anchor is requested", async () => {
    runMock.mockResolvedValue({ data: { block_id: "blkNew" } })
    await execute("upload_image", { imagePath: "/audit.png" })
    expect(runMock).toHaveBeenCalledTimes(1)
    expect(runMock.mock.calls[0][0].args).not.toContain("--selection-with-ellipsis")
  })

  it("does not upload when the anchor lookup fails", async () => {
    runMock.mockRejectedValueOnce(new Error("anchor not found"))
    await expect(execute("upload_image", input)).rejects.toThrow("anchor not found")
    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it("does not move or delete anything when uploading fails", async () => {
    runMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("upload failed"))
    await expect(execute("upload_image", input)).rejects.toThrow("upload failed")
    expect(runMock).toHaveBeenCalledTimes(2)
  })

  it("removes only the newly created image when moving it fails", async () => {
    runMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ block_id: "blkNew" })
      .mockRejectedValueOnce(new Error("move failed"))
      .mockResolvedValueOnce({})
    await expect(execute("upload_image", input)).rejects.toThrow("move failed")
    expect(runMock.mock.calls[3][0].args).toEqual([
      "docs",
      "+update",
      "--doc",
      doc,
      "--command",
      "block_delete",
      "--block-id",
      "blkNew",
    ])
  })

  it("reports the created block if cleanup also fails", async () => {
    runMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ data: { block_id: "blkNew" } })
      .mockRejectedValueOnce(new Error("move failed"))
      .mockRejectedValueOnce(new Error("cleanup failed"))
    await expect(execute("upload_image", input)).rejects.toThrow(/blkNew.*cleanup failed/)
  })

  it("fails explicitly if the upload response does not identify the created block", async () => {
    runMock.mockResolvedValueOnce({}).mockResolvedValueOnce({ data: { file_token: "img" } })
    await expect(execute("upload_image", input)).rejects.toThrow(/created block id/)
    expect(runMock).toHaveBeenCalledTimes(2)
  })
})

const binary = process.env.LARK_CLI_BIN || "lark-cli"
const cliIt = spawnSync(binary, ["--version"], { encoding: "utf8" }).status === 0 ? it : it.skip

describe("generated document arguments against the installed CLI", () => {
  cliIt("accepts the ingestion fetch arguments and extracts the CLI body", async () => {
    const exec = jest.fn(async (input: { args: readonly string[] }) => {
      const output = spawnSync(binary, [...input.args, "--dry-run"], { encoding: "utf8" })
      expect(output.status).toBe(0)
      return {
        status: "ok" as const,
        adapterId: "audit",
        data: { data: { document: { content: "# Imported", title: "Title" } } },
      }
    })
    await expect(
      fetchLarkDocAsRawSource(doc, { adapterId: "audit", channel: "cli", execImpl: exec })
    ).resolves.toMatchObject({ text: "# Imported", title: "Title", contentType: "text/markdown" })
  })

  const cases: Array<[string, Record<string, unknown>]> = [
    ["delete", {}],
    [
      "fetch",
      {
        mode: "range",
        startBlockId: "blkStart",
        endBlockId: "blkEnd",
        format: "with-ids",
        contentFormat: "markdown",
        revisionId: 2,
      },
    ],
    ["fetch", { mode: "section", sectionId: "blkHeading" }],
    ["fetch", { mode: "keyword", keyword: "needle" }],
    ["update", { operation: "append", payload: "# Heading", format: "markdown", revisionId: 2 }],
    ["update", { operation: "str_replace", payload: "", anchor: "remove me" }],
    ["update", { operation: "block_delete", anchor: "blk1,blk2" }],
    [
      "update",
      { operation: "block_move_after", anchor: "blkTarget", sourceBlockIds: ["blk1", "blk2"] },
    ],
    [
      "update",
      { operation: "block_copy_insert_after", anchor: "blkTarget", sourceBlockIds: ["blk1"] },
    ],
    ["upload_image", { imagePath: "public/icons/icon-192.png", anchorBlockId: "blkTarget" }],
  ]
  cliIt.each(cases)(
    "accepts generated %s arguments for %j without executing requests",
    async (verb, args) => {
      runMock.mockResolvedValue({ data: { block_id: "blkNew" } })
      await execute(verb, args)
      for (const [call] of runMock.mock.calls) {
        const output = spawnSync(
          binary,
          [...call.args, "--dry-run", ...(call.confirmed ? ["--yes"] : [])],
          { encoding: "utf8" }
        )
        const scopeBlocked =
          output.status === 3 && output.stderr.includes('"subtype": "missing_scope"')
        if (output.status !== 0 && !scopeBlocked) {
          // Report only the command error, never the CLI's account context.
          let reason = `exit ${String(output.status)}`
          try {
            reason = JSON.parse(output.stdout || output.stderr).error?.message ?? reason
          } catch {
            /* retain exit status */
          }
          throw new Error(`${call.args.slice(0, 2).join(" ")}: ${reason}`)
        }
      }
    }
  )
})
