import { render, screen } from "@testing-library/react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { MEMORY_SOURCES, MemoryReconstruction } from "./memory-reconstruction"

describe("MemoryReconstruction", () => {
  it("carries the reconstruction marker", () => {
    render(<MemoryReconstruction copy={en.reconstruction} />)
    expect(screen.getByText(en.reconstruction.label)).toBeInTheDocument()
  })

  it("names the file every remembered fact came from", () => {
    render(<MemoryReconstruction copy={en.reconstruction} />)
    for (const entry of en.reconstruction.memory.entries) {
      expect(screen.getByText(entry.text)).toBeInTheDocument()
    }
    for (const source of MEMORY_SOURCES) {
      expect(screen.getByText(source)).toBeInTheDocument()
    }
  })

  it("reads its sources from the signature task's fixture", () => {
    expect(MEMORY_SOURCES).toEqual([
      DEMO_TASK.files[1].path,
      DEMO_TASK.files[2].path,
      DEMO_TASK.artifact.file,
    ])
  })

  it("marks only the entry still waiting for review, and says it is reviewed first", () => {
    const { container } = render(<MemoryReconstruction copy={en.reconstruction} />)
    const pending = container.querySelectorAll("[data-memory-pending]")
    expect(pending).toHaveLength(1)
    expect(pending[0]).toHaveTextContent(en.reconstruction.memory.entries.at(-1)!.state)
    expect(screen.getByText(en.reconstruction.memory.pendingLabel)).toBeInTheDocument()
  })

  it("has one source per entry in both locales", () => {
    expect(en.reconstruction.memory.entries).toHaveLength(MEMORY_SOURCES.length)
    expect(zh.reconstruction.memory.entries).toHaveLength(MEMORY_SOURCES.length)
  })

  it("does not nest paragraphs, which breaks hydration", () => {
    const { container } = render(<MemoryReconstruction copy={en.reconstruction} />)
    expect(container.querySelectorAll("p p")).toHaveLength(0)
  })

  it("localises", () => {
    render(<MemoryReconstruction copy={zh.reconstruction} />)
    expect(screen.getByText(zh.reconstruction.memory.searchQuery)).toBeInTheDocument()
  })
})
