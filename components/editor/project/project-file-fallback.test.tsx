/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ProjectFileFallback } from "./project-file-fallback"
import type { OpenFile } from "./use-project-editor"

function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    relPath: "assets/logo.png",
    absolutePath: "/repo/assets/logo.png",
    language: "plaintext",
    monacoLanguage: "plaintext",
    savedContent: "",
    draftContent: "",
    draftVersion: 1,
    blocked: "binary",
    sizeBytes: 1024,
    ...overrides,
  }
}

describe("ProjectFileFallback", () => {
  it("explains a binary file with no preview capability", () => {
    render(<ProjectFileFallback file={file()} rootPath="/repo" onOpenAnyway={jest.fn()} />)
    expect(screen.getByTestId("project-file-fallback")).toBeInTheDocument()
    expect(screen.getByText("logo.png")).toBeInTheDocument()
    expect(screen.getByText("1.0 KB")).toBeInTheDocument()
    // No byte reader → metadata pane, honest degradation.
    expect(screen.queryByTestId("fallback-image-preview")).not.toBeInTheDocument()
  })

  it("previews an image when the transport can read bytes", async () => {
    const readFileBase64 = jest.fn().mockResolvedValue("QUJD")
    render(
      <ProjectFileFallback
        file={file()}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={readFileBase64}
      />
    )
    await waitFor(() => expect(screen.getByTestId("fallback-image-preview")).toBeInTheDocument())
    expect(readFileBase64).toHaveBeenCalledWith("/repo", "assets/logo.png", 20 * 1024 * 1024)
    expect(screen.getByTestId("fallback-image-preview")).toHaveAttribute(
      "src",
      "data:image/png;base64,QUJD"
    )
  })

  it("uses the jpeg mime for .jpg files", async () => {
    render(
      <ProjectFileFallback
        file={file({ relPath: "photo.jpg" })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={jest.fn().mockResolvedValue("AA==")}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId("fallback-image-preview")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,AA=="
      )
    )
  })

  it("skips the read for images over the preview ceiling", () => {
    const readFileBase64 = jest.fn()
    render(
      <ProjectFileFallback
        file={file({ sizeBytes: 21 * 1024 * 1024 })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={readFileBase64}
      />
    )
    expect(readFileBase64).not.toHaveBeenCalled()
    expect(screen.queryByTestId("fallback-image-preview")).not.toBeInTheDocument()
  })

  it("degrades to the icon pane when the byte read fails", async () => {
    render(
      <ProjectFileFallback
        file={file()}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={jest.fn().mockRejectedValue(new Error("denied"))}
      />
    )
    await waitFor(() =>
      expect(screen.queryByTestId("fallback-image-preview")).not.toBeInTheDocument()
    )
    expect(screen.getByText("logo.png")).toBeInTheDocument()
  })

  it("does not preview a binary file that merely has an image name", () => {
    const readFileBase64 = jest.fn()
    render(
      <ProjectFileFallback
        file={file({ relPath: "sound.mp3" })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={readFileBase64}
      />
    )
    expect(readFileBase64).not.toHaveBeenCalled()
  })

  it("offers open-anyway for too-large files and reports the size", () => {
    const onOpenAnyway = jest.fn()
    render(
      <ProjectFileFallback
        file={file({ blocked: "too-large", relPath: "big.log", sizeBytes: 12 * 1024 * 1024 })}
        rootPath="/repo"
        onOpenAnyway={onOpenAnyway}
      />
    )
    expect(
      screen.getByText("The file is too large (12.0 MB) to display in the editor.")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("fallback-open-anyway"))
    expect(onOpenAnyway).toHaveBeenCalledTimes(1)
  })

  it("hides open-anyway for binary files", () => {
    render(<ProjectFileFallback file={file()} rootPath="/repo" onOpenAnyway={jest.fn()} />)
    expect(screen.queryByTestId("fallback-open-anyway")).not.toBeInTheDocument()
  })

  it.each([
    ["clip.mp4", "lucide-video"],
    ["pack.zip", "lucide-file-archive"],
    ["blob.bin", "lucide-file-question-mark"],
    ["sound.wav", "lucide-music"],
  ])("shows the %s kind icon for %s", (relPath, iconClass) => {
    const { container } = render(
      <ProjectFileFallback file={file({ relPath })} rootPath="/repo" onOpenAnyway={jest.fn()} />
    )
    expect(container.querySelector(`svg.${iconClass}`)).not.toBeNull()
  })

  it("resets the preview when the bound file changes", async () => {
    const readFileBase64 = jest.fn().mockResolvedValue("QUJD")
    const { rerender } = render(
      <ProjectFileFallback
        file={file()}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={readFileBase64}
      />
    )
    await waitFor(() => expect(screen.getByTestId("fallback-image-preview")).toBeInTheDocument())
    // Re-binding to a non-image file drops the preview for the honest icon pane.
    rerender(
      <ProjectFileFallback
        file={file({ relPath: "pack.zip" })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={readFileBase64}
      />
    )
    expect(screen.queryByTestId("fallback-image-preview")).not.toBeInTheDocument()
    // And re-binding to another image re-reads and previews again.
    rerender(
      <ProjectFileFallback
        file={file({ relPath: "other.png" })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={readFileBase64}
      />
    )
    await waitFor(() => expect(screen.getByTestId("fallback-image-preview")).toBeInTheDocument())
    expect(readFileBase64).toHaveBeenLastCalledWith("/repo", "other.png", 20 * 1024 * 1024)
  })

  it("handles a too-large file whose size is unknown", () => {
    render(
      <ProjectFileFallback
        file={file({ blocked: "too-large", relPath: "big.log", sizeBytes: undefined })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
      />
    )
    expect(screen.getByTestId("fallback-open-anyway")).toBeInTheDocument()
  })

  it("formats byte sizes and renders the touch density", () => {
    render(
      <ProjectFileFallback
        file={file({ relPath: "tiny.bin", sizeBytes: 512 })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        density="touch"
      />
    )
    expect(screen.getByText("512 B")).toBeInTheDocument()
    expect(screen.getByTestId("project-file-fallback").querySelector(".size-20")).not.toBeNull()
  })

  it("uses the icon mime for .ico previews", async () => {
    render(
      <ProjectFileFallback
        file={file({ relPath: "favicon.ico" })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
        readFileBase64={jest.fn().mockResolvedValue("AA==")}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId("fallback-image-preview")).toHaveAttribute(
        "src",
        "data:image/x-icon;base64,AA=="
      )
    )
  })

  it("names extensionless files without an icon kind", () => {
    render(
      <ProjectFileFallback
        file={file({ relPath: "LICENSE" })}
        rootPath="/repo"
        onOpenAnyway={jest.fn()}
      />
    )
    expect(screen.getByText("LICENSE")).toBeInTheDocument()
  })
})
