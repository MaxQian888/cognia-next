import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fsp from "node:fs/promises"

import { createNotebookEditTool } from "./notebook-edit.mjs"
import { createReadTracker } from "./read-tracker.mjs"

const SAMPLE = JSON.stringify(
  {
    cells: [
      { cell_type: "code", id: "c1", source: ["print(1)\n"], outputs: [], execution_count: null },
      { cell_type: "markdown", id: "m1", source: ["# Title\n"] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  },
  null,
  1
)

async function writeNb(content = SAMPLE) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nbedit-"))
  const p = path.join(dir, "nb.ipynb")
  await fsp.writeFile(p, content, "utf-8")
  return p
}

function textOf(result) {
  return result.content.map((c) => c.text).join("")
}

test("NotebookEdit replaces a cell after a read", async () => {
  const p = await writeNb()
  const readTracker = createReadTracker()
  const st = await fsp.stat(p)
  readTracker.record(p, st)

  const toolDef = createNotebookEditTool({ cwd: path.dirname(p), readTracker })
  const result = await toolDef.handler({ file_path: p, cell_id: "c1", new_source: "print(99)" }, {})
  assert.equal(result.isError, undefined)
  assert.match(textOf(result), /Replaced/)

  const after = JSON.parse(await fsp.readFile(p, "utf-8"))
  assert.deepEqual(after.cells[0].source, ["print(99)"])
})

test("NotebookEdit refuses to edit a notebook that was not read first", async () => {
  const p = await writeNb()
  const toolDef = createNotebookEditTool({ cwd: path.dirname(p), readTracker: createReadTracker() })
  const result = await toolDef.handler({ file_path: p, cell_id: "c1", new_source: "x" }, {})
  assert.equal(result.isError, true)
  assert.match(textOf(result), /has not been read/)
})

test("NotebookEdit inserts and deletes cells", async () => {
  const p = await writeNb()
  const readTracker = createReadTracker()
  readTracker.record(p, await fsp.stat(p))
  const toolDef = createNotebookEditTool({ cwd: path.dirname(p), readTracker })

  const ins = await toolDef.handler(
    { file_path: p, cell_id: "c1", new_source: "y=2", edit_mode: "insert" },
    {}
  )
  assert.match(textOf(ins), /Inserted/)
  let nb = JSON.parse(await fsp.readFile(p, "utf-8"))
  assert.equal(nb.cells.length, 3)

  // re-read after the write (mtime changed), then delete
  readTracker.record(p, await fsp.stat(p))
  const del = await toolDef.handler({ file_path: p, cell_id: "m1", edit_mode: "delete" }, {})
  assert.match(textOf(del), /Deleted/)
  nb = JSON.parse(await fsp.readFile(p, "utf-8"))
  assert.ok(!nb.cells.some((c) => c.id === "m1"))
})

test("NotebookEdit reports a missing file and a bad locator", async () => {
  const missing = createNotebookEditTool({ cwd: os.tmpdir(), readTracker: createReadTracker() })
  const r1 = await missing.handler(
    { file_path: path.join(os.tmpdir(), "nope.ipynb"), new_source: "x" },
    {}
  )
  assert.equal(r1.isError, true)
  assert.match(textOf(r1), /not found/)

  const p = await writeNb()
  const readTracker = createReadTracker()
  readTracker.record(p, await fsp.stat(p))
  const toolDef = createNotebookEditTool({ cwd: path.dirname(p), readTracker })
  const r2 = await toolDef.handler({ file_path: p, cell_id: "ghost", new_source: "x" }, {})
  assert.equal(r2.isError, true)
  assert.match(textOf(r2), /could not locate/)
})
