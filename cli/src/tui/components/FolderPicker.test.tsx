import { CliI18nProvider } from "../i18n"
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

  it("selects a highlighted child directory directly", () => {
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

  it("expands nested directories and collapses back to their parent", () => {
    const onConfirm = jest.fn()
    const { container } = render(
      <FolderPicker
        initialDir={START}
        onConfirm={onConfirm}
        onCancel={() => {}}
        listDirs={(dir) =>
          dir === START ? ["alpha"] : dir === path.join(START, "alpha") ? ["nested"] : []
        }
      />
    )
    key({ downArrow: true })
    key({ downArrow: true })
    expect(container.textContent).not.toContain("nested/")
    key({ rightArrow: true })
    expect(container.textContent).toContain("nested/")
    key({ rightArrow: true })
    key({ return: true })
    expect(onConfirm).toHaveBeenCalledWith(path.join(START, "alpha", "nested"))
    key({ leftArrow: true })
    key({ leftArrow: true })
    expect(container.textContent).not.toContain("nested/")
  })

  it("toggles hidden directories and refreshes filesystem contents", () => {
    let names = [".config", "visible"]
    const { container } = render(
      <FolderPicker
        initialDir={START}
        onConfirm={() => {}}
        onCancel={() => {}}
        listDirs={() => names}
      />
    )
    expect(container.textContent).not.toContain(".config/")
    act(() => __fireInput(".", {}))
    expect(container.textContent).toContain(".config/")
    names = ["new-directory"]
    act(() => __fireInput("r", {}))
    expect(container.textContent).toContain("new-directory/")
    expect(container.textContent).not.toContain("visible/")
  })

  it("shows expanded directory errors and retains selectable siblings", () => {
    const { container } = render(
      <FolderPicker
        initialDir={START}
        onConfirm={() => {}}
        onCancel={() => {}}
        listDirs={(dir) => {
          if (dir !== START) throw new Error("EACCES")
          return ["blocked", "sibling"]
        }}
      />
    )
    key({ downArrow: true })
    key({ downArrow: true })
    key({ rightArrow: true })
    expect(container.textContent).toContain("EACCES")
    expect(container.textContent).toContain("sibling/")
  })

  it("uses Backspace for parent navigation and omits the parent at filesystem root", () => {
    const onConfirm = jest.fn()
    const { container } = render(
      <FolderPicker
        initialDir="/tmp"
        onConfirm={onConfirm}
        onCancel={() => {}}
        listDirs={() => []}
      />
    )
    key({ backspace: true })
    expect(container.textContent).not.toContain("..")
    key({ return: true })
    expect(onConfirm).toHaveBeenCalledWith("/")
  })

  it("keeps long directory lists inside the supplied visible row window", () => {
    const { container } = render(
      <FolderPicker
        initialDir={START}
        onConfirm={() => {}}
        onCancel={() => {}}
        width={80}
        maxRows={5}
        listDirs={() =>
          Array.from({ length: 30 }, (_, i) => `folder-${String(i).padStart(2, "0")}`)
        }
      />
    )
    expect(container.textContent).not.toContain("folder-29/")
    for (let i = 0; i < 31; i++) key({ downArrow: true })
    expect(container.textContent).toContain("folder-29/")
    expect(container.textContent).not.toContain("folder-00/")
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

  it("surfaces directory read failures", () => {
    const missing = path.join(os.tmpdir(), "folderpicker-does-not-exist-xyz")
    const { container } = render(
      <FolderPicker initialDir={missing} onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(container.textContent ?? "").toContain("ENOENT")
  })
})

it("renders Chinese startup copy and preserves technical content", () => {
  __resetInk()
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <FolderPicker
        initialDir="/workspace"
        onConfirm={() => {}}
        onCancel={() => {}}
        listDirs={() => ["project"]}
      />
    </CliI18nProvider>
  )
  expect(container.textContent).toContain("使用此文件夹")
  expect(container.textContent).toContain("project/")
})

describe("FolderPicker filesystem changes", () => {
  beforeEach(() => __resetInk())

  it("includes symlink directories but skips file and broken links", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picker-links-"))
    try {
      fs.mkdirSync(path.join(tmp, "directory"))
      fs.writeFileSync(path.join(tmp, "file.txt"), "test")
      fs.symlinkSync(path.join(tmp, "directory"), path.join(tmp, "directory-link"))
      fs.symlinkSync(path.join(tmp, "file.txt"), path.join(tmp, "file-link"))
      fs.symlinkSync(path.join(tmp, "missing"), path.join(tmp, "broken-link"))
      const { container } = render(
        <FolderPicker initialDir={tmp} onConfirm={() => {}} onCancel={() => {}} />
      )
      expect(container.textContent).toContain("directory-link/")
      expect(container.textContent).not.toContain("file-link/")
      expect(container.textContent).not.toContain("broken-link/")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("refuses a selected directory deleted since listing and can refresh", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picker-delete-"))
    try {
      const child = path.join(tmp, "child")
      fs.mkdirSync(child)
      const onConfirm = jest.fn()
      const { container } = render(
        <FolderPicker initialDir={tmp} onConfirm={onConfirm} onCancel={() => {}} />
      )
      key({ downArrow: true })
      key({ downArrow: true })
      fs.rmdirSync(child)
      key({ return: true })
      expect(onConfirm).not.toHaveBeenCalled()
      expect(container.textContent).toContain("ENOENT")
      act(() => __fireInput("r", {}))
      expect(container.textContent).not.toContain("child/")
      expect(container.textContent).not.toContain("ENOENT")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("rejects a path replaced with a file and surfaces permission failures", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picker-permission-"))
    try {
      const child = path.join(tmp, "child")
      fs.mkdirSync(child)
      const onConfirm = jest.fn()
      const { container } = render(
        <FolderPicker initialDir={tmp} onConfirm={onConfirm} onCancel={() => {}} />
      )
      key({ downArrow: true })
      key({ downArrow: true })
      fs.rmdirSync(child)
      fs.writeFileSync(child, "changed")
      key({ return: true })
      expect(onConfirm).not.toHaveBeenCalled()
      expect(container.textContent).toContain("no longer a directory")
      fs.unlinkSync(child)
      fs.mkdirSync(child)
      const access = jest.spyOn(fs, "accessSync").mockImplementation(() => {
        throw new Error("EACCES")
      })
      try {
        key({ return: true })
        expect(onConfirm).not.toHaveBeenCalled()
        expect(container.textContent).toContain("EACCES")
      } finally {
        access.mockRestore()
      }
      key({ return: true })
      expect(onConfirm).toHaveBeenCalledWith(child)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("keeps the directory just left selected when navigating to its parent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picker-parent-"))
    try {
      const child = path.join(tmp, ".child")
      fs.mkdirSync(child)
      const onConfirm = jest.fn()
      const { container } = render(
        <FolderPicker initialDir={child} onConfirm={onConfirm} onCancel={() => {}} />
      )
      key({ backspace: true })
      expect(container.textContent).toContain(".child/")
      key({ return: true })
      expect(onConfirm).toHaveBeenCalledWith(child)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("preserves selected paths across refresh and clamps a removed last row", () => {
    let names = ["beta", "gamma"]
    const onConfirm = jest.fn()
    render(
      <FolderPicker
        initialDir={START}
        onConfirm={onConfirm}
        onCancel={() => {}}
        listDirs={() => names}
      />
    )
    key({ downArrow: true })
    key({ downArrow: true })
    key({ downArrow: true })
    names = ["alpha", "beta", "gamma"]
    act(() => __fireInput("r", {}))
    key({ return: true })
    expect(onConfirm).toHaveBeenLastCalledWith(path.join(START, "gamma"))
    names = ["alpha", "beta"]
    act(() => __fireInput("r", {}))
    key({ return: true })
    expect(onConfirm).toHaveBeenLastCalledWith(path.join(START, "beta"))
  })
})
