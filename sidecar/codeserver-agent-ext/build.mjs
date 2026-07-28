// Build the Cognia Agent Bridge extension and package it as a .vsix.
//
//   1. esbuild-bundle `src/extension.mjs` → `dist/extension.js` (CJS, `vscode`
//      external — the host provides it at runtime).
//   2. Assemble a VSIX (a ZIP in the Open Packaging Conventions layout that
//      `code-server --install-extension` accepts) via the system `zip`.
//
// The produced `.vsix` is committed and shipped as a Tauri resource
// (`src-tauri/tauri.conf.json` → `bundle.resources`); `codeserver::process`
// side-loads it on first spawn. Re-run this after changing the extension.

import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, "dist")
const stage = join(root, ".vsix-stage")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
// Stable filename (version lives inside the manifest) so bumping the extension
// version never churns the Tauri resource path or the Rust install constant.
const vsixName = "cognia-agent-bridge.vsix"
const vsixPath = join(root, vsixName)

// 1. Bundle.
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
await build({
  entryPoints: [join(root, "src/extension.mjs")],
  outfile: join(dist, "extension.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  // `vscode` is injected by the extension host; never bundle it.
  external: ["vscode"],
  legalComments: "none",
})
await build({
  entryPoints: [join(root, "src/proxy-extension.mjs")],
  outfile: join(dist, "proxy.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  legalComments: "none",
})

// 2. Assemble the VSIX.
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, "extension", "dist"), { recursive: true })
cpSync(join(root, "package.json"), join(stage, "extension", "package.json"))
cpSync(join(dist, "extension.js"), join(stage, "extension", "dist", "extension.js"))
cpSync(join(dist, "proxy.js"), join(stage, "extension", "dist", "proxy.js"))
writeFileSync(join(stage, "extension.vsixmanifest"), vsixManifest(pkg))
writeFileSync(join(stage, "[Content_Types].xml"), contentTypes())

rmSync(vsixPath, { force: true })
// `zip . ` (not the bracketed filename) so the `[Content_Types].xml` name is
// never interpreted as a shell/zip glob pattern.
execFileSync("zip", ["-r", "-X", "-q", vsixPath, "."], { cwd: stage })
rmSync(stage, { recursive: true, force: true })

console.log(`built ${vsixName}`)

function vsixManifest(pkg) {
  const engine = pkg.engines?.vscode ?? "^1.80.0"
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Tags>cognia</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${engine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`
}

function contentTypes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
`
}
