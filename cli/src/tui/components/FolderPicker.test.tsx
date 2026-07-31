import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { FolderPicker } from "./FolderPicker"

const START = path.resolve("/repo/project")

/** Fire a key and flush the resulting state update + effect re-registration. */
function key(opts: Record<string, boolean>) {
  act(() => __fireInput("", opts))
}

describe("FolderPicker", () => {
  beforeEach(() => __resetInk())

  it("lists confirm, up, and child directories", () => {
    const { container } = render(
      <FolderPicker
        initialDir={START}
        onConfirm={() => {}}
        onCancel={() => {}}
        listDirs={() => ["alpha", "beta"]}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Use this folder")
    expect(text).toContain("..")
    expect(text).toContain("alpha/")
    expect(text).toContain("beta/")
  })

  it("confirms the current folder on the first row", () => {
    const onConfirm = jest.fn()
    render(
      <FolderPicker
        initialDir={START}
        onConfirm={onConfirm}
        onCancel={() => {}}
        listDirs={() => ["alpha"]}
      />
    )
    key({ return: true })
    expect(onConfirm).toHaveBeenCalledWith(START)
  })

  it("descends into a child directory then confirms it", () => {
    const onConfirm = jest.fn()
    render(
      <FolderPicker
        initialDir={START}
        onConfirm={onConfirm}
        onCancel={() => {}}
        listDirs={() => ["alpha", "beta"]}
      />
    )
    // rows: [confirm, .., alpha/, beta/] → move down twice to "alpha/"
    key({ downArrow: true })
    key({ downArrow: true })
    key({ return: true })
    // now inside alpha; row 0 is confirm again
    key({ return: true })
    expect(onConfirm).toHaveBeenCalledWith(path.join(START, "alpha"))
  })

  it("walks up via the .. row", () => {
    const onConfirm = jest.fn()
    render(
      <FolderPicker
        initialDir={START}
        onConfirm={onConfirm}
        onCancel={() => {}}
        listDirs={() => []}
      />
    )
    // rows: [confirm, ..] → move to ".." and enter
    key({ downArrow: true })
    key({ return: true })
    key({ return: true }) // confirm parent
    expect(onConfirm).toHaveBeenCalledWith(path.dirname(START))
  })

  it("cancels on Escape", () => {
    const onCancel = jest.fn()
    render(
      <FolderPicker
        initialDir={START}
        onConfirm={() => {}}
        onCancel={onCancel}
        listDirs={() => []}
      />
    )
    key({ escape: true })
    expect(onCancel).toHaveBeenCalled()
  })

  it("lists real sub-directories (and skips files) with the default fs lister", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "folderpicker-"))
    try {
      fs.mkdirSync(path.join(tmp, "alpha"))
      fs.mkdirSync(path.join(tmp, "beta"))
      fs.writeFileSync(path.join(tmp, "notes.txt"), "x")
      // No `listDirs` prop → exercises the real-filesystem default reader.
      const { container } = render(
        <FolderPicker initialDir={tmp} onConfirm={() => {}} onCancel={() => {}} />
      )
      const text = container.textContent ?? ""
      expect(text).toContain("alpha/")
      expect(text).toContain("beta/")
      expect(text).not.toContain("notes.txt")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("returns no children when the directory cannot be read", () => {
    const missing = path.join(os.tmpdir(), "folderpicker-does-not-exist-xyz")
    const { container } = render(
      <FolderPicker initialDir={missing} onConfirm={() => {}} onCancel={() => {}} />
    )
    // Only the confirm + ".." rows render; the unreadable dir yields no children.
    expect(container.textContent ?? "").toContain("Use this folder")
  })
})
