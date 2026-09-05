import fs from "node:fs"
import path from "node:path"
import { npmBinaryPath } from "../../../sidecar/builtin-tools/ast-grep/binary.mjs"

/** All CLI layouts carry the same installed, platform-specific AST search binary. */
export function stageAstGrep({ outDir, platform = process.platform, arch = process.arch }) {
  const source = npmBinaryPath(platform, arch)
  if (!source) throw new Error(`AST search binary for ${platform}-${arch} is missing; install the matching @ast-grep/cli optional dependency before packaging the CLI.`)
  const destination = path.join(outDir, "sidecar", platform === "win32" ? "ast-grep.exe" : "ast-grep")
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  if (platform !== "win32") fs.chmodSync(destination, 0o755)
  return destination
}
