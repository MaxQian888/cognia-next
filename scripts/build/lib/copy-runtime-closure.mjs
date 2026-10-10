import fs from "node:fs"
import path from "node:path"

// Copy packages and everything they load at runtime into one plain
// node_modules tree (ADR-0224 A1).
//
// Copying a package directory alone is not enough: pnpm keeps a package's
// dependencies beside it in the virtual store, and peer dependencies (the
// Claude Agent SDK's `@modelcontextprotocol/sdk`, `zod`, `@anthropic-ai/sdk`)
// are never nested inside it in any layout. This walks `dependencies` and
// `peerDependencies` from each package's real location and lays the closure
// out flat, nesting a dependency under its dependent only when a different
// version already holds the flat slot. Optional dependencies are skipped: the
// platform runtimes that need them are staged on purpose by their own step.

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
}

/** Where Node would find `name` when required from inside `fromDir`. */
export function findInstalledPackage(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, "node_modules", name)
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Whether `child` is `dir` or inside it. */
function isInside(child, dir) {
  return child === dir || child.startsWith(dir + path.sep)
}

/**
 * Copy `names` (resolved from `fromDir`) and their runtime closure into
 * `destNodeModules`. Returns the copied packages as `name@version → dest`.
 * Throws when a required (non-optional) dependency is not installed, or when
 * no placement lets every dependent resolve the version it needs.
 */
export function copyRuntimeClosure({ names, fromDir, destNodeModules }) {
  const root = path.dirname(destNodeModules)
  const slots = new Map() // `<dir>/node_modules/<name>` → version there (undefined: free)
  // A previous closure copied into the same tree already holds its slots.
  const versionAt = (slot) => {
    if (!slots.has(slot)) {
      slots.set(slot, fs.existsSync(path.join(slot, "package.json")) ? readManifest(slot).version : undefined)
    }
    return slots.get(slot)
  }
  // Node's lookup slots for `name` from a package directory in the tree,
  // nearest first, ending at `destNodeModules/<name>`.
  const lookupSlots = (dir, name) => {
    const found = []
    for (let current = dir; current !== root; current = path.dirname(current)) {
      if (current === destNodeModules) continue
      if (path.basename(current) !== "node_modules") found.push(path.join(current, "node_modules", name))
    }
    found.push(path.join(destNodeModules, name))
    return found
  }
  const resolved = [] // { from, name, slot }: what each dependent resolves to
  const copied = new Map() // `${name}@${version}` → dest dir
  const queue = names.map((name) => ({ name, from: fromDir, parentDest: null, requiredBy: "(root)", optional: false }))
  while (queue.length > 0) {
    const { name, from, parentDest, requiredBy, optional } = queue.shift()
    const source = findInstalledPackage(name, from)
    if (!source) {
      if (optional) continue
      throw new Error(`runtime dependency ${name} of ${requiredBy} is not installed (looked up from ${from})`)
    }
    const manifest = readManifest(source)
    const key = `${name}@${manifest.version}`
    const dependent = parentDest ?? root
    const candidates = lookupSlots(dependent, name)
    const nearest = candidates.find((slot) => versionAt(slot) !== undefined)
    if (nearest !== undefined && versionAt(nearest) === manifest.version) {
      resolved.push({ from: dependent, name, slot: nearest })
      continue
    }
    let dest
    if (nearest === undefined) {
      // Free all the way up: keep the tree flat.
      dest = candidates[candidates.length - 1]
    } else if (nearest !== candidates[0]) {
      // Another version is visible from here: nest this one under its dependent.
      dest = candidates[0]
    } else {
      throw new Error(`${key} needed by ${requiredBy} conflicts with ${name}@${versionAt(nearest)} at ${nearest}`)
    }
    // A package already placed inside this scope that resolved another version
    // from further up would now see this one instead.
    const scope = path.dirname(path.dirname(dest))
    const shadowed = resolved.find(
      (entry) =>
        entry.name === name &&
        isInside(entry.from, scope) &&
        !isInside(entry.slot, scope) &&
        versionAt(entry.slot) !== manifest.version
    )
    if (shadowed) {
      throw new Error(
        `${key} at ${dest} would hide ${name}@${versionAt(shadowed.slot)} from ${shadowed.from}, which needs it`
      )
    }
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      // The package's own node_modules is left behind: this walk places
      // every dependency, and a copied one would look already resolved.
      const ownModules = path.join(source, "node_modules")
      fs.cpSync(source, dest, { recursive: true, dereference: true, filter: (src) => !isInside(src, ownModules) })
    }
    slots.set(dest, manifest.version)
    resolved.push({ from: dependent, name, slot: dest })
    if (!copied.has(key)) copied.set(key, dest)
    const optionalPeers = manifest.peerDependenciesMeta ?? {}
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dep, from: source, parentDest: dest, requiredBy: key, optional: false })
    }
    for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
      queue.push({
        name: dep,
        from: source,
        parentDest: dest,
        requiredBy: key,
        optional: optionalPeers[dep]?.optional === true,
      })
    }
  }
  return copied
}
