import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
  ImageCatalogEntryEditor,
  type ImageCatalogEntryEditorProps,
} from "./image-catalog-entry-editor"
import { CatalogProblemError } from "@/hooks/sandbox/use-image-catalog"
import type { ResolvedCatalogImage } from "@/lib/project-environment/catalog-entry-draft"
import type { CatalogEntryRecord, CatalogRows } from "@/lib/project-environment/environment-client"
import en from "@/i18n/messages/en/settings/imageCatalog.json"

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args) } }))

const DIGEST = `sha256:${"a".repeat(64)}`
const OTHER = `sha256:${"b".repeat(64)}`

const facts: CatalogRows["facts"] = {
  poolEnabled: true,
  multiTenant: false,
  floor: "gvisor",
  sizeClasses: [
    {
      id: "gpu",
      label: "GPU",
      cpuMillis: 8000,
      memoryMib: 32768,
      ephemeralStorageMib: 1,
      volumeMib: 1,
      gpu: { count: 1, resourceName: "nvidia.com/gpu" },
    },
    {
      id: "small",
      label: "Small",
      cpuMillis: 1000,
      memoryMib: 2048,
      ephemeralStorageMib: 8192,
      volumeMib: 20480,
    },
    {
      id: "large",
      label: "Large",
      cpuMillis: 4000,
      memoryMib: 8192,
      ephemeralStorageMib: 8192,
      volumeMib: 20480,
    },
  ],
  egressPresets: [],
}

const resolved: ResolvedCatalogImage = {
  registry: "ghcr.io",
  repository: "acme/dev",
  digest: DIGEST,
  tag: "22",
  user: "node",
  platforms: ["linux/amd64", "linux/arm64"],
}

function record(overrides: Partial<CatalogEntryRecord> = {}): CatalogEntryRecord {
  return {
    id: "node-22",
    scope: "tenant",
    label: "Node 22",
    image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST, tag: "22" },
    isolationFloor: "vm",
    sizeClassIds: ["large", "small"],
    imageUser: "node",
    source: "build",
    createdAt: 5,
    updatedAt: 6,
    ...overrides,
  }
}

function renderEditor(overrides: Partial<ImageCatalogEntryEditorProps> = {}) {
  const props: ImageCatalogEntryEditorProps = {
    open: true,
    onOpenChange: jest.fn(),
    facts,
    busy: false,
    inspect: jest.fn(async () => resolved),
    save: jest.fn(async () => ({ ok: true as const })),
    ...overrides,
  }
  render(<ImageCatalogEntryEditor {...props} />)
  return props
}

const field = (label: string) => screen.getByLabelText(label)

beforeEach(() => toastSuccess.mockReset())

describe("adding an image", () => {
  it("starts at the deployment floor with its first usable size", () => {
    renderEditor()
    expect(screen.getByRole("heading", { name: en.editor.createTitle })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: en.editor.floor })).toHaveTextContent("gVisor")
    expect(screen.getByRole("checkbox", { name: /^Small:/ })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: /^Large:/ })).not.toBeChecked()
    expect(field(en.editor.id)).toBeEnabled()
  })

  it("resolves the reference, then saves the pinned entry", async () => {
    const props = renderEditor()
    fireEvent.change(field(en.editor.id), { target: { value: "node-22" } })
    fireEvent.change(field(en.editor.label), { target: { value: "Node 22" } })
    fireEvent.change(field(en.editor.image), { target: { value: "ghcr.io/acme/dev:22" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.resolve }))
    })

    expect(props.inspect).toHaveBeenCalledWith("ghcr.io/acme/dev:22")
    const summary = screen.getByTestId("resolved-image")
    expect(summary).toHaveTextContent(`Pinned to ghcr.io/acme/dev:22@${DIGEST}`)
    expect(summary).toHaveTextContent("Runs as node")
    expect(summary).toHaveTextContent("Platforms: linux/amd64, linux/arm64")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.save }))
    })
    expect(props.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "node-22",
        label: "Node 22",
        image: resolved,
        isolationFloor: "gvisor",
        sizeClassIds: ["small"],
      }),
      undefined
    )
    expect(toastSuccess).toHaveBeenCalledWith("Node 22 saved.")
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  // A digest resolved from one text must never be saved under another.
  it("drops the resolution when the reference changes", async () => {
    renderEditor()
    fireEvent.change(field(en.editor.image), { target: { value: "ghcr.io/acme/dev:22" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.resolve }))
    })
    expect(screen.getByTestId("resolved-image")).toBeInTheDocument()

    fireEvent.change(field(en.editor.image), { target: { value: "ghcr.io/acme/dev:23" } })
    expect(screen.queryByTestId("resolved-image")).not.toBeInTheDocument()
  })

  it("names every problem on save instead of sending the draft", async () => {
    const props = renderEditor()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.save }))
    })
    expect(props.save).not.toHaveBeenCalled()
    expect(screen.getByText(en.editor.problem.id)).toBeInTheDocument()
    expect(screen.getByText(en.editor.problem.label)).toBeInTheDocument()
    expect(screen.getByText(en.editor.problem.imageUnresolved)).toBeInTheDocument()
  })

  it("stays quiet about problems until the person tries to save", () => {
    renderEditor()
    expect(screen.queryByText(en.editor.problem.id)).not.toBeInTheDocument()
  })

  it("refuses an image whose platforms disagree about the user", async () => {
    const props = renderEditor({ inspect: jest.fn(async () => ({ ...resolved, user: null })) })
    fireEvent.change(field(en.editor.id), { target: { value: "multi" } })
    fireEvent.change(field(en.editor.label), { target: { value: "Multi" } })
    fireEvent.change(field(en.editor.image), { target: { value: "ghcr.io/acme/dev:22" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.resolve }))
    })
    // No "runs as" line: there is no single answer to show.
    expect(screen.getByTestId("resolved-image")).not.toHaveTextContent("Runs as")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.save }))
    })
    expect(screen.getByText(en.editor.problem.imageUserAmbiguous)).toBeInTheDocument()
    expect(props.save).not.toHaveBeenCalled()
  })

  it("shows a refused resolution with the Host's code and words", async () => {
    renderEditor({
      inspect: jest.fn(async () => {
        throw new CatalogProblemError({
          code: "catalog_registry_not_allowlisted",
          message: "evil.io is not allowed",
        })
      }),
    })
    fireEvent.change(field(en.editor.image), { target: { value: "evil.io/x:1" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.resolve }))
    })
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(en.errors.catalogRegistryNotAllowlisted)
    expect(alert).toHaveTextContent("evil.io is not allowed")
  })

  it("keeps the dialog open on a refused save and says why", async () => {
    const props = renderEditor({
      save: jest.fn(async () => ({
        ok: false as const,
        problem: { code: "catalog_entry_duplicate", message: "exists" },
      })),
    })
    fireEvent.change(field(en.editor.id), { target: { value: "node-22" } })
    fireEvent.change(field(en.editor.label), { target: { value: "Node 22" } })
    fireEvent.change(field(en.editor.image), { target: { value: "ghcr.io/acme/dev:22" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.resolve }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.save }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent(en.errors.catalogEntryDuplicate)
    expect(props.onOpenChange).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  // Working Rule 7: GPU size classes are listed, labeled, and not choosable.
  it("lists GPU sizes as unavailable", () => {
    renderEditor()
    const gpu = screen.getByRole("checkbox", {
      name: "GPU (1 × nvidia.com/gpu): GPU sandboxes are not available yet",
    })
    expect(gpu).toBeDisabled()
    expect(gpu.closest("[data-dormant]")).toHaveAttribute("data-dormant", "gpu")
  })

  it("asks for a default only once several sizes are chosen, and moves it first", async () => {
    const props = renderEditor()
    expect(screen.queryByRole("combobox", { name: en.editor.defaultSize })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: /^Large:/ }))

    const trigger = screen.getByRole("combobox", { name: en.editor.defaultSize })
    expect(trigger).toHaveTextContent("Small")
    fireEvent.keyDown(trigger, { key: "Enter" })
    fireEvent.click(await screen.findByRole("option", { name: "Large" }))

    fireEvent.change(field(en.editor.id), { target: { value: "n" } })
    fireEvent.change(field(en.editor.label), { target: { value: "N" } })
    fireEvent.change(field(en.editor.image), { target: { value: "ghcr.io/acme/dev:22" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.resolve }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.save }))
    })
    expect(props.save).toHaveBeenCalledWith(
      expect.objectContaining({ sizeClassIds: ["large", "small"] }),
      undefined
    )
  })
})

describe("editing an image", () => {
  it("opens the entry as saved, resolved, with its id locked", () => {
    renderEditor({ existing: record() })
    expect(screen.getByRole("heading", { name: "Edit Node 22" })).toBeInTheDocument()
    expect(field(en.editor.id)).toBeDisabled()
    expect(field(en.editor.id)).toHaveValue("node-22")
    expect(field(en.editor.image)).toHaveValue(`ghcr.io/acme/dev:22@${DIGEST}`)
    expect(screen.getByTestId("resolved-image")).toHaveTextContent("Runs as node")
    expect(screen.getByRole("combobox", { name: en.editor.floor })).toHaveTextContent(
      "Virtual machine"
    )
    expect(screen.getByRole("combobox", { name: en.editor.defaultSize })).toHaveTextContent("Large")
  })

  it("saves a relabeled entry without asking the registry again", async () => {
    const existing = record()
    const props = renderEditor({ existing })
    fireEvent.change(field(en.editor.label), { target: { value: "Node 22 LTS" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.save }))
    })
    expect(props.inspect).not.toHaveBeenCalled()
    expect(props.save).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Node 22 LTS", id: "node-22" }),
      existing
    )
  })

  it("requires resolving again after the image is changed", async () => {
    const existing = record()
    const props = renderEditor({
      existing,
      inspect: jest.fn(async () => ({ ...resolved, digest: OTHER, tag: "24" })),
    })
    fireEvent.change(field(en.editor.image), { target: { value: "ghcr.io/acme/dev:24" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.save }))
    })
    expect(props.save).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.resolve }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.editor.save }))
    })
    await waitFor(() =>
      expect(props.save).toHaveBeenCalledWith(
        expect.objectContaining({ image: expect.objectContaining({ digest: OTHER }) }),
        existing
      )
    )
  })
})
