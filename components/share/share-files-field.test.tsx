import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("./share-files-picker", () => ({
  ShareFilesPicker: () => <div data-testid="share-files-picker" />,
}))

import type { ShareFileSelection } from "@/hooks/share/use-share-file-selection"
import type { ExpandedShareSelection, ShareFileCandidate } from "@/lib/share/file-selection"
import type { FileSpacePath } from "@/types/filespace"

import { ShareFilesField, type ShareFilesFieldProps } from "./share-files-field"

const LOADED = {
  space: { sessionId: "s1", status: "available", mounts: [], hostId: "local" },
  dexie: { uploads: [], artifacts: [] },
} as unknown as ShareFileSelection["loaded"]

function candidate(path: string, size: number, sensitive = false): ShareFileCandidate {
  return {
    path: path as FileSpacePath,
    name: path.slice(path.lastIndexOf("/") + 1),
    mime: "text/plain",
    size,
    sensitive,
    open: jest.fn(),
  }
}

function expanded(partial: Partial<ExpandedShareSelection>): ExpandedShareSelection {
  return { files: [], skippedSensitive: 0, truncated: false, issues: [], ...partial }
}

function renderField(props: Partial<ShareFilesFieldProps> = {}) {
  const all: ShareFilesFieldProps = {
    selection: { loaded: LOADED, expanded: expanded({}), pending: false, failed: false },
    selected: [],
    onToggle: jest.fn(),
    confirmedSensitive: new Set(),
    onConfirmSensitive: jest.fn(),
    violations: [],
    ...props,
  }
  return { ...render(<ShareFilesField {...all} />), props: all }
}

describe("ShareFilesField", () => {
  it("opens the picker when nothing is chosen yet", () => {
    renderField()
    expect(screen.getByText(/No files chosen/)).toBeInTheDocument()
    expect(screen.getByTestId("share-files-picker")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true")
  })

  it("summarises the chosen files and keeps the picker closed until asked", async () => {
    const user = userEvent.setup()
    renderField({
      selected: ["/workspace" as FileSpacePath],
      selection: {
        loaded: LOADED,
        expanded: expanded({
          files: [candidate("/workspace/a", 1024), candidate("/workspace/b", 1024)],
        }),
        pending: false,
        failed: false,
      },
    })
    expect(screen.getByRole("status")).toHaveTextContent("2 files · 2.0 KB")
    expect(screen.queryByTestId("share-files-picker")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Choose files" }))
    expect(screen.getByTestId("share-files-picker")).toBeInTheDocument()
  })

  it("shows progress while the selection is being expanded", () => {
    renderField({
      selected: ["/workspace" as FileSpacePath],
      selection: { loaded: LOADED, expanded: null, pending: true, failed: false },
    })
    expect(screen.getByRole("status")).toHaveTextContent("Collecting the chosen files…")
  })

  it("says why the picker cannot open: still loading, or the conversation is gone", () => {
    const { unmount } = renderField({
      selection: { loaded: undefined, expanded: expanded({}), pending: false, failed: false },
    })
    expect(screen.getByText("Loading…")).toBeInTheDocument()
    unmount()
    renderField({
      selection: { loaded: null, expanded: expanded({}), pending: false, failed: false },
    })
    expect(screen.getByText("This conversation is no longer available.")).toBeInTheDocument()
  })

  it("reports a failed expansion, withheld credentials, truncation and per-path issues", () => {
    renderField({
      selected: ["/workspace" as FileSpacePath],
      selection: {
        loaded: LOADED,
        expanded: expanded({
          skippedSensitive: 2,
          truncated: true,
          issues: [
            { path: "/roots/x" as FileSpacePath, reason: "offline" },
            { path: "/uploads/gone.png" as FileSpacePath, reason: "source-unavailable" },
          ],
        }),
        pending: false,
        failed: true,
      },
    })
    expect(screen.getByText(/could not be read/)).toBeInTheDocument()
    expect(
      screen.getByText("2 files that look like credentials were left out of the chosen folders.")
    ).toBeInTheDocument()
    expect(screen.getByText(/more files than one link can carry/)).toBeInTheDocument()
    expect(screen.getByText("/roots/x is on a host that is offline.")).toBeInTheDocument()
    expect(
      screen.getByText("/uploads/gone.png has no stored copy on this device.")
    ).toBeInTheDocument()
  })

  it("leaves a credential-like file out of the count until it is ticked by path", async () => {
    const user = userEvent.setup()
    const onConfirmSensitive = jest.fn()
    const selection: ShareFileSelection = {
      loaded: LOADED,
      expanded: expanded({
        files: [candidate("/workspace/a", 1024), candidate("/workspace/.env", 10, true)],
      }),
      pending: false,
      failed: false,
    }
    const { rerender, props } = renderField({
      selected: ["/workspace" as FileSpacePath],
      selection,
      onConfirmSensitive,
    })
    expect(screen.getByRole("status")).toHaveTextContent("1 file · 1.0 KB")
    expect(screen.getByText("These look like credentials")).toBeInTheDocument()
    await user.click(screen.getByRole("checkbox", { name: "Include /workspace/.env" }))
    expect(onConfirmSensitive).toHaveBeenCalledWith("/workspace/.env", true)

    rerender(<ShareFilesField {...props} confirmedSensitive={new Set(["/workspace/.env"])} />)
    expect(screen.getByRole("status")).toHaveTextContent("2 files · 1.0 KB")
    expect(screen.getByRole("checkbox", { name: "Include /workspace/.env" })).toBeChecked()
  })

  it("names each server limit the selection is over", () => {
    renderField({
      selected: ["/workspace" as FileSpacePath],
      violations: [
        { kind: "too-many-files", count: 201, max: 200 },
        {
          kind: "file-too-large",
          path: "/workspace/big.iso",
          size: 600 * 1024 ** 2,
          max: 512 * 1024 ** 2,
        },
        { kind: "total-too-large", total: 3 * 1024 ** 3, max: 2 * 1024 ** 3 },
      ],
    })
    expect(
      screen.getByText("201 files chosen; one link can carry at most 200.")
    ).toBeInTheDocument()
    expect(screen.getByText(/\/workspace\/big\.iso is larger than 512/)).toBeInTheDocument()
    expect(screen.getByText(/Together the files are larger than 2/)).toBeInTheDocument()
  })
})
