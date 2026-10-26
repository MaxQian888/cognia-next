import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assertNoLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Plugin dependencies contain a symbolic link: ${path}`);
    if (entry.isDirectory()) assertNoLinks(path);
  }
}

/** Materialize only npm's links to this checkout's own workspace packages. */
export function materializeWorkspaceLinks(root) {
  const modules = join(root, "node_modules");
  const packages = join(root, "packages");
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(packages, entry.name);
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    if (!/^@latexwb\/[a-z0-9-]+$/.test(manifest.name))
      throw new Error("Unexpected workspace package name");
    const installed = join(modules, manifest.name);
    if (!existsSync(installed)) continue;
    if (!lstatSync(installed).isSymbolicLink()) continue;
    if (realpathSync(installed) !== realpathSync(source))
      throw new Error(`Workspace link escapes its package: ${installed}`);
    assertNoLinks(source);
    const target = manifest.exports?.["."];
    if (Object.keys(manifest.exports ?? {}).length !== 1 || typeof target !== "string")
      throw new Error(`Unexpected workspace exports: ${manifest.name}`);
    const entryPath = resolve(source, target);
    const sourceRelative = relative(source, entryPath);
    if (isAbsolute(sourceRelative) || sourceRelative.startsWith("..") || !existsSync(entryPath))
      throw new Error(`Workspace export escapes its package: ${manifest.name}`);
    const scratch = mkdtempSync(join(modules, ".latexwb-copy-"));
    try {
      const copy = join(scratch, "package");
      cpSync(source, copy, { recursive: true, dereference: false });
      // Node cannot strip TypeScript in node_modules. A regular ESM bridge
      // resolves the unchanged source outside node_modules without symlinks.
      const specifier = relative(installed, entryPath).split("\\").join("/");
      writeFileSync(
        join(copy, "plugin-entry.mjs"),
        `export * from ${JSON.stringify(specifier)};\n`
      );
      writeFileSync(
        join(copy, "package.json"),
        JSON.stringify(
          {
            ...manifest,
            exports: { ".": "./plugin-entry.mjs" },
          },
          null,
          2
        ) + "\n"
      );
      unlinkSync(installed);
      renameSync(copy, installed);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  assertNoLinks(modules);
}

export function preparePlugin(root = dirname(fileURLToPath(import.meta.url))) {
  const npm = process.env.npm_execpath;
  if (!npm || !existsSync(npm)) throw new Error("Run this command through npm run prepare:plugin");
  execFileSync(
    process.execPath,
    [
      npm,
      "ci",
      "--omit=dev",
      "--omit=peer",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-bin-links",
    ],
    { cwd: root, stdio: "inherit" }
  );
  materializeWorkspaceLinks(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  preparePlugin();
