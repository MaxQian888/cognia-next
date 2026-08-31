import {
  FILE_TYPE_ICON_KINDS,
  basenameOf,
  resolveFileTypeIcon,
  type FileTypeIconKind,
} from "./file-type-icon"

describe("resolveFileTypeIcon", () => {
  it("gives a directory the folder kind regardless of its name", () => {
    // A directory called `styles.css` is still a directory; guessing from the
    // string is how a folder ends up wearing a stylesheet icon.
    expect(resolveFileTypeIcon("components/styles.css", true).kind).toBe("folder")
    expect(resolveFileTypeIcon("lib/files", true).kind).toBe("folder")
  })

  it.each<[string, FileTypeIconKind]>([
    ["components/chat/composer.tsx", "react"],
    ["lib/files/file-type-icon.ts", "typescript"],
    ["scripts/build.mjs", "javascript"],
    ["app/page.jsx", "react"],
    ["src/App.vue", "vue"],
    ["src/App.svelte", "svelte"],
    ["tools/run.py", "python"],
    ["src-tauri/src/lib.rs", "rust"],
    ["cmd/main.go", "go"],
    ["Main.java", "java"],
    ["app/models/user.rb", "ruby"],
    ["public/index.php", "php"],
    ["scripts/deploy.sh", "shell"],
    ["i18n/messages/en.json", "json"],
    [".github/workflows/ci.yml", "yaml"],
    ["rustfmt.toml", "toml"],
    ["public/feed.xml", "xml"],
    ["public/index.html", "html"],
    ["app/globals.css", "css"],
    ["docs/guide.mdx", "markdown"],
    ["notes.txt", "text"],
    ["report.pdf", "pdf"],
    ["brief.docx", "document"],
    ["budget.xlsx", "spreadsheet"],
    ["deck.pptx", "presentation"],
    ["assets/logo.svg", "image"],
    ["clip.mp4", "video"],
    ["track.flac", "audio"],
    ["fonts/Inter.woff2", "font"],
    ["backup.zip", "archive"],
    ["schema.sql", "database"],
    ["certs/server.pem", "key"],
    ["target/app.wasm", "binary"],
    ["analysis.ipynb", "notebook"],
  ])("classifies %s as %s", (path, kind) => {
    expect(resolveFileTypeIcon(path).kind).toBe(kind)
  })

  it.each<[string, FileTypeIconKind]>([
    ["package.json", "package"],
    ["pnpm-lock.yaml", "lock"],
    ["Cargo.toml", "package"],
    ["Cargo.lock", "lock"],
    ["Dockerfile", "docker"],
    ["docker-compose.yml", "docker"],
    [".gitignore", "git"],
    [".env", "key"],
    ["Makefile", "config"],
    ["README.md", "markdown"],
  ])("matches the whole name for %s before any extension", (name, kind) => {
    // `package.json` is not "a JSON file" to anyone reading a diff, and
    // `Dockerfile` has no extension to match on at all.
    expect(resolveFileTypeIcon(name).kind).toBe(kind)
  })

  it("matches the exact name case-insensitively and through a directory prefix", () => {
    expect(resolveFileTypeIcon("infra/DOCKERFILE").kind).toBe("docker")
    expect(resolveFileTypeIcon("/abs/path/Package.json").kind).toBe("package")
  })

  it("prefers the longest dotted suffix", () => {
    // `.d.ts` and `.tar.gz` both lose their meaning if the shortest suffix wins.
    expect(resolveFileTypeIcon("types/global.d.ts").kind).toBe("typescript")
    expect(resolveFileTypeIcon("dist/bundle.tar.gz").kind).toBe("archive")
    // Falling back down the chain still works when the long suffix is unknown.
    expect(resolveFileTypeIcon("component.stories.tsx").kind).toBe("react")
  })

  it("reads the extension of a dotfile instead of treating the name as a suffix", () => {
    expect(resolveFileTypeIcon(".eslintrc.json").kind).toBe("json")
    expect(resolveFileTypeIcon(".prettierrc.yaml").kind).toBe("yaml")
  })

  it("falls back to the generic file kind rather than guessing", () => {
    expect(resolveFileTypeIcon("data.qqq").kind).toBe("file")
    expect(resolveFileTypeIcon("noextension").kind).toBe("file")
    expect(resolveFileTypeIcon("").kind).toBe("file")
  })

  it("gives every kind a tone", () => {
    // A kind with no tone renders an uncoloured glyph, which reads as a bug
    // rather than a choice.
    for (const kind of FILE_TYPE_ICON_KINDS) {
      const tone = resolveFileTypeIcon(`x.${kind}`).tone
      expect(typeof tone).toBe("string")
    }
    expect(FILE_TYPE_ICON_KINDS).toContain("file")
    expect(FILE_TYPE_ICON_KINDS).toContain("folder")
  })
})

describe("basenameOf", () => {
  it.each([
    ["a/b/c.ts", "c.ts"],
    ["a\\b\\c.ts", "c.ts"],
    ["c.ts", "c.ts"],
    ["a/b/", "b"],
    ["/", ""],
  ])("reduces %s to %s", (input, expected) => {
    expect(basenameOf(input)).toBe(expected)
  })
})
