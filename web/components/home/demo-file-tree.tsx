"use client"

import { useState } from "react"

import { Tree, type TreeViewElement } from "@web/components/ui/file-tree"
import { DEMO_TASK } from "@web/content/demo-task"
import type { TaskArtifactsCopy } from "@web/content/types"

interface DemoFileTreeProps {
  /** Accessible name for the tree region. */
  ariaLabel: string
  copy: TaskArtifactsCopy["context"]
}

/**
 * A file tree showing the signature task's repository files.
 *
 * Renders `DEMO_TASK.files` under `DEMO_TASK.repository` as a collapsible
 * tree using Magic UI's FileTree component. All folders are expanded by default.
 *
 * No animation (FileTree is inherently static), so no reduced-motion gate needed.
 */
export function DemoFileTree({ ariaLabel, copy }: DemoFileTreeProps) {
  const [selectedId, setSelectedId] = useState("file-source")
  const selectedFile = FILE_BY_ID[selectedId] ?? DEMO_TASK.files[0]

  return (
    <div
      className="grid w-full min-w-0 border-y border-on-stage-hairline font-mono text-sm text-on-stage md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
      aria-label={ariaLabel}
      role="region"
    >
      <div className="min-h-56 py-4 md:border-r md:border-on-stage-hairline">
        <Tree
          elements={TREE_DATA}
          selectedId={selectedId}
          onSelectedIdChange={setSelectedId}
          initialExpandedItems={["root", "src", "src-checkout"]}
          className="text-on-stage"
        />
      </div>
      <div className="border-t border-on-stage-hairline p-4 md:border-t-0" aria-live="polite">
        <p className="text-[10px] uppercase tracking-widest text-on-stage-muted">
          {copy.filesLabel}
        </p>
        <p className="mt-3 break-all text-xs text-on-stage">{selectedFile.path}</p>
        <p className="mt-3 font-sans text-sm leading-relaxed text-on-stage-muted">
          {copy.fileNotes[selectedFile.key]}
        </p>
        {selectedFile.key === "instructions" ? (
          <ul className="mt-4 flex flex-col gap-2 border-t border-on-stage-hairline pt-4 font-sans">
            {copy.instructions.map((instruction) => (
              <li key={instruction} className="text-sm leading-relaxed text-on-stage-muted">
                {instruction}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

const FILE_BY_ID = Object.fromEntries(
  DEMO_TASK.files.map((file) => [`file-${file.key}`, file])
) as Record<string, (typeof DEMO_TASK.files)[number]>

/** Pre-built tree data for the `elements` prop fallback. */
const TREE_DATA: TreeViewElement[] = [
  {
    id: "root",
    name: DEMO_TASK.repository,
    type: "folder",
    children: [
      {
        id: "src",
        name: "src",
        type: "folder",
        children: [
          {
            id: "src-checkout",
            name: "checkout",
            type: "folder",
            children: [
              { id: "file-source", name: "total.ts", type: "file" },
              { id: "file-test", name: "total.test.ts", type: "file" },
            ],
          },
        ],
      },
      { id: "file-instructions", name: "AGENTS.md", type: "file" },
    ],
  },
]
