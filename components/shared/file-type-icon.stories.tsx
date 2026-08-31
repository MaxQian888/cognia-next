import type { Meta, StoryObj } from "@storybook/nextjs"

import { FileTypeIcon } from "./file-type-icon"

const meta = {
  title: "Shared/FileTypeIcon",
  component: FileTypeIcon,
  parameters: { layout: "padded" },
  args: { path: "components/chat/composer.tsx" },
} satisfies Meta<typeof FileTypeIcon>

export default meta
type Story = StoryObj<typeof meta>

const SAMPLES = [
  "components/chat/composer.tsx",
  "lib/files/file-type-icon.ts",
  "scripts/build.mjs",
  "src/App.vue",
  "src/App.svelte",
  "tools/analyze.py",
  "src-tauri/src/lib.rs",
  "cmd/server.go",
  "Main.java",
  "app/models/user.rb",
  "public/index.php",
  "scripts/release.sh",
  "package.json",
  "pnpm-lock.yaml",
  "Cargo.toml",
  "Dockerfile",
  ".gitignore",
  ".env",
  "Makefile",
  "README.md",
  ".github/workflows/ci.yml",
  "public/index.html",
  "app/globals.css",
  "notes.txt",
  "report.pdf",
  "brief.docx",
  "budget.xlsx",
  "deck.pptx",
  "analysis.ipynb",
  "assets/logo.svg",
  "media/clip.mp4",
  "media/track.flac",
  "fonts/Inter.woff2",
  "dist/bundle.tar.gz",
  "db/schema.sql",
  "certs/server.pem",
  "target/app.wasm",
  "types/global.d.ts",
  "data/unknown.qqq",
]

/** Every type side by side — the point is that no two categories read alike. */
export const Catalogue: Story = {
  render: () => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1">
      {SAMPLES.map((path) => (
        <div key={path} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs">
          <FileTypeIcon path={path} />
          <span className="truncate font-mono">{path}</span>
        </div>
      ))}
    </div>
  ),
}

/** A directory keeps the folder glyph whatever its name looks like. */
export const Directories: Story = {
  render: () => (
    <div className="flex flex-col gap-1 text-xs">
      {["lib/files", "components/chat", "styles.css"].map((path) => (
        <div key={path} className="flex items-center gap-2">
          <FileTypeIcon path={path} isDir />
          <span className="font-mono">{path}</span>
        </div>
      ))}
    </div>
  ),
}

/** `muted` drops the per-type colour for rows that carry their own state ink. */
export const Muted: Story = {
  render: () => (
    <div className="flex flex-col gap-1 text-xs">
      {["app.tsx", "logo.png", "pnpm-lock.yaml"].map((path) => (
        <div key={path} className="flex items-center gap-2">
          <FileTypeIcon path={path} />
          <FileTypeIcon path={path} muted />
          <span className="font-mono">{path}</span>
        </div>
      ))}
    </div>
  ),
}
