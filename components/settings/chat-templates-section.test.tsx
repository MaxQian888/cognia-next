/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))
const downloadBlobMock = jest.fn()
jest.mock("@cognia/plugin-sdk/api/download", () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a),
}))
const saveToRepoMock = jest.fn()
jest.mock("@/lib/chat/template/repo-template-write", () => ({
  saveChatTemplateToRepository: (...a: unknown[]) => saveToRepoMock(...a),
}))
const loadRepoMock = jest.fn<Promise<RepoChatTemplate[]>, [string | null | undefined]>()
jest.mock("@/hooks/chat/use-repo-chat-templates", () => ({
  loadRepoChatTemplates: (root: string | null | undefined) => loadRepoMock(root),
}))
jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  resolveEffectiveCwdForSession: async () => "/repo",
}))

import { ChatTemplatesSection } from "./chat-templates-section"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createChatTemplate, getChatTemplate, listChatTemplates } from "@/lib/db/chat-templates"
import {
  parseRepoTemplate,
  serializeChatTemplate,
  type RepoChatTemplate,
} from "@/lib/chat/template/repo-templates"

beforeEach(async () => {
  toastSuccess.mockClear()
  toastError.mockClear()
  downloadBlobMock.mockClear()
  saveToRepoMock.mockReset()
  saveToRepoMock.mockResolvedValue({ ok: true, path: ".cognia/templates/review.md" })
  loadRepoMock.mockReset()
  loadRepoMock.mockResolvedValue([])
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

/** jsdom's Blob has no `.text()`, and the app does not use it either. */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

async function mount() {
  await act(async () => {
    render(<ChatTemplatesSection />)
  })
}

describe("ChatTemplatesSection", () => {
  it("says so when nothing has been saved", async () => {
    await mount()

    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists a template with its parameters", async () => {
    await createChatTemplate({ name: "Review a PR", body: "review {{module}} on {{branch}}" })

    await mount()

    await waitFor(() => expect(screen.getByText("Review a PR")).toBeInTheDocument())
    expect(screen.getByText("module")).toBeInTheDocument()
    expect(screen.getByText("branch")).toBeInTheDocument()
  })

  it("edits the body and re-derives what the template asks for", async () => {
    // Saving used to be a one-way door: a typo in the body was permanent.
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    fireEvent.change(screen.getByLabelText("body"), {
      target: { value: "review {{module}} on {{branch}}" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    await waitFor(async () => {
      const stored = await getChatTemplate(row.id)
      expect(stored?.body).toBe("review {{module}} on {{branch}}")
      expect(stored?.params.map((p) => p.id)).toEqual(["module", "branch"])
      // A content edit invalidates drafts that quoted the old body.
      expect(stored?.revision).toBe(2)
    })
  })

  it("deletes a template", async () => {
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "delete" }))
    })

    await waitFor(async () => expect(await listChatTemplates()).toEqual([]))
  })
})

describe("ChatTemplatesSection — parameter declarations", () => {
  it("makes a parameter optional, so a send no longer waits on it", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "paramRequired" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    const saved = await getChatTemplate(row.id)
    expect(saved?.params).toEqual([
      { id: "module", label: "module", required: false, kind: "string" },
    ])
    // A declaration change IS content: a draft quoting the old revision must
    // not silently inherit the new rules.
    expect(saved?.revision).toBe(2)
  })

  it("keeps an edited label when the body is rewritten around it", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    fireEvent.change(screen.getByLabelText("paramLabel"), { target: { value: "Which module" } })
    fireEvent.change(screen.getByLabelText("body"), {
      target: { value: "please review {{module}} today" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    const saved = await getChatTemplate(row.id)
    expect(saved?.params[0].label).toBe("Which module")
    expect(saved?.body).toBe("please review {{module}} today")
  })
})

describe("ChatTemplatesSection — portability", () => {
  it("exports the same Markdown document the composer reads back", async () => {
    await createChatTemplate({ name: "Review a PR", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review a PR")).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /exportAction/ }))
    })

    expect(downloadBlobMock).toHaveBeenCalledTimes(1)
    const [filename, blob] = downloadBlobMock.mock.calls[0] as [string, Blob]
    expect(filename).toBe("review-a-pr.md")
    const parsed = parseRepoTemplate(filename, await readBlobText(blob))
    expect(parsed?.name).toBe("Review a PR")
    expect(parsed?.body).toBe("review {{module}}")
  })

  it("imports a Markdown file under a freshly minted id", async () => {
    await mount()
    const file = new File(
      [serializeChatTemplate({ name: "From a file", body: "do {{thing}}", params: [] })],
      "from-a-file.md",
      { type: "text/markdown" }
    )

    await act(async () => {
      fireEvent.change(screen.getByLabelText("importAction"), { target: { files: [file] } })
    })

    await waitFor(async () => {
      const rows = await listChatTemplates()
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe("From a file")
      // The parser's id names a FILE. Reusing it would collide with the
      // checkout's own template the moment one is opened.
      expect(rows[0].id.startsWith("repo:")).toBe(false)
      expect(rows[0].id.startsWith("tpl_")).toBe(true)
    })
  })

  it("says so rather than saving nothing when the file is not a template", async () => {
    await mount()
    const file = new File(["---\nname: [\n---\nbody"], "broken.md", { type: "text/markdown" })

    await act(async () => {
      fireEvent.change(screen.getByLabelText("importAction"), { target: { files: [file] } })
    })

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("importFailed"))
    expect(await listChatTemplates()).toEqual([])
  })

  it("writes to the workspace the send path would use", async () => {
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /saveToRepo/ }))
    })

    await waitFor(() => expect(saveToRepoMock).toHaveBeenCalled())
    expect(saveToRepoMock.mock.calls[0][0]).toBe("/repo")
    // The mocked translator echoes the key, so the assertion is on WHICH
    // message was raised, not on its interpolation.
    expect(toastSuccess).toHaveBeenCalledWith("savedToRepo")
  })

  it("asks before replacing a file a teammate may have written", async () => {
    saveToRepoMock.mockResolvedValueOnce({
      ok: false,
      reason: "exists",
      path: ".cognia/templates/review.md",
    })
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /saveToRepo/ }))
    })

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toBeInTheDocument()
    // Nothing was written yet: the second call is the confirmed one.
    expect(saveToRepoMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "overwriteConfirm" }))
    })

    await waitFor(() => expect(saveToRepoMock).toHaveBeenCalledTimes(2))
    expect(saveToRepoMock.mock.calls[1][2]).toEqual({ overwrite: true })
  })

  it("names the reason a write was refused", async () => {
    saveToRepoMock.mockResolvedValueOnce({
      ok: false,
      reason: "restricted",
      path: ".cognia/templates/review.md",
    })
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /saveToRepo/ }))
    })

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("saveToRepoRestricted"))
  })

  it("duplicates a template as a new one, with no history behind it", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "duplicate" }))
    })

    await waitFor(async () => expect(await listChatTemplates()).toHaveLength(2))
    const copy = (await listChatTemplates()).find((t) => t.id !== row.id)!
    expect(copy.name).toBe("duplicatedName")
    expect(copy.usageCount).toBe(0)
    expect(copy.revision).toBe(1)
    expect(copy.params).toEqual(row.params)
  })
})

describe("ChatTemplatesSection — repository templates", () => {
  const repoRow = {
    id: "repo:review",
    name: "Team review",
    body: "review {{module}}",
    params: [{ id: "module", label: "module", required: true, kind: "string" as const }],
    launchSpec: { permissionMode: "plan" as const },
    revision: 7,
    source: "repo" as const,
    sourcePath: ".cognia/templates/review.md",
  }

  it("lists what the checkout contributes, read-only and named by its file", async () => {
    loadRepoMock.mockResolvedValue([repoRow])
    await mount()

    await waitFor(() => expect(screen.getByTestId("repo-chat-templates")).toBeInTheDocument())
    expect(screen.getByText("Team review")).toBeInTheDocument()
    expect(screen.getByText(".cognia/templates/review.md")).toBeInTheDocument()
    // A file is not editable from here, and the page must not pretend it is.
    expect(screen.queryByRole("button", { name: "edit" })).toBeNull()
  })

  it("adopts one into the local table under a fresh id, keeping the demoted setup", async () => {
    loadRepoMock.mockResolvedValue([repoRow])
    await mount()
    await waitFor(() => expect(screen.getByText("Team review")).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "adopt" }))
    })

    await waitFor(async () => {
      const rows = await listChatTemplates()
      expect(rows).toHaveLength(1)
      expect(rows[0].id.startsWith("repo:")).toBe(false)
      expect(rows[0].name).toBe("Team review")
      // Adopting must not be a way to launder a setup past the trust gate: the
      // spec copied is the one the reader already demoted.
      expect(rows[0].launchSpec).toEqual({ permissionMode: "plan" })
    })
  })

  it("reads the checkout through the loader the composer uses, under the same root", async () => {
    loadRepoMock.mockResolvedValue([])
    await mount()

    await waitFor(() => expect(loadRepoMock).toHaveBeenCalledWith("/repo"))
  })
})

describe("ChatTemplatesSection — mobile layout", () => {
  /**
   * At 375px the title and the five actions cannot share a row. The `mobile`
   * flag stacks them instead of letting the action cluster push the name out of
   * the card, which is the same collapse `prompt-presets-section` does.
   */
  it("stacks the card header instead of laying it out in a row", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    const { container } = render(<ChatTemplatesSection mobile />)
    await act(async () => {
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    const header = container.querySelector('[data-slot="card-header"]')
    expect(header?.className).toContain("flex-col")
    expect(header?.className).not.toContain("flex-row")
  })

  it("keeps the desktop row layout when the flag is off", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    const { container } = render(<ChatTemplatesSection />)
    await act(async () => {
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    const header = container.querySelector('[data-slot="card-header"]')
    expect(header?.className).toContain("flex-row")
  })
})
