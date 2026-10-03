/**
 * VS Code's glob syntax, for `workspace.findFiles` and file watchers.
 *
 *   - `*` matches within one path segment, `?` one character of a segment;
 *   - `**` as a whole segment matches any number of segments, none included
 *     (`**​/x`, `a/**​/b`, and `a/**`, which also matches `a` itself);
 *   - `{a,b}` matches either alternative, which may hold globs and `/`;
 *   - `[abc]`, `[a-z]` and `[!a]` / `[^a]` match one character, never `/`.
 *
 * Paths use `/`; matching is case-sensitive, as VS Code's is. This is a
 * different grammar from `lib/files/glob-match.ts` (whose slash-less
 * patterns match any segment), so extensions get VS Code's answers.
 */

/** Longer patterns are refused rather than compiled. */
export const MAX_GLOB_LENGTH = 4096

const SPECIAL = /[.+^${}()|[\]\\]/g

function literal(text: string): string {
  return text.replace(SPECIAL, "\\$&")
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function closingBrace(glob: string, open: number): number {
  let depth = 0
  for (let index = open; index < glob.length; index += 1) {
    if (glob[index] === "{") depth += 1
    else if (glob[index] === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** The top-level comma-separated alternatives inside braces. */
function alternatives(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1
    else if (body[index] === "}") depth -= 1
    else if (body[index] === "," && depth === 0) {
      out.push(body.slice(start, index))
      start = index + 1
    }
  }
  out.push(body.slice(start))
  return out
}

/**
 * Regex source for `glob`. `atStart` / `atEnd` say whether its edges are
 * path-segment boundaries, which decides whether a `**` there is a globstar.
 */
function compile(glob: string, atStart: boolean, atEnd: boolean): string {
  let source = ""
  let index = 0
  const boundaryBefore = (at: number) => (at === 0 ? atStart : glob[at - 1] === "/")
  const boundaryAfter = (at: number) => (at === glob.length ? atEnd : glob[at] === "/")
  while (index < glob.length) {
    const char = glob[index]
    if (char === "/" && glob.slice(index) === "/**" && atEnd) {
      // `a/**` is `a` and everything inside it.
      source += "(?:/.*)?"
      break
    }
    if (char === "*") {
      let end = index
      while (glob[end] === "*") end += 1
      if (end - index >= 2 && boundaryBefore(index) && boundaryAfter(end)) {
        if (end === glob.length) {
          source += ".*"
          index = end
        } else {
          // `**/` is any number of whole segments, none included.
          source += "(?:.*/)?"
          index = end + 1
        }
      } else {
        source += "[^/]*"
        index = end
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      index += 1
      continue
    }
    if (char === "[") {
      let close = index + 1
      if (glob[close] === "!" || glob[close] === "^") close += 1
      if (glob[close] === "]") close += 1
      while (close < glob.length && glob[close] !== "]") close += 1
      if (close < glob.length) {
        let body = glob.slice(index + 1, close)
        const negated = body.startsWith("!") || body.startsWith("^")
        if (negated) body = body.slice(1)
        const escaped = body.replace(/[\\\]^]/g, "\\$&")
        source += `(?!/)[${negated ? "^" : ""}${escaped}]`
        index = close + 1
        continue
      }
      source += "\\["
      index += 1
      continue
    }
    if (char === "{") {
      const close = closingBrace(glob, index)
      if (close !== -1) {
        const start = boundaryBefore(index)
        const end = boundaryAfter(close + 1)
        source += `(?:${alternatives(glob.slice(index + 1, close))
          .map((part) => compile(part, start, end))
          .join("|")})`
        index = close + 1
        continue
      }
    }
    source += literal(char)
    index += 1
  }
  return source
}

const cache = new Map<string, RegExp>()
const CACHE_LIMIT = 500

/** The pattern compiled; throws for an over-long pattern. */
export function globRegExp(glob: string): RegExp {
  const cached = cache.get(glob)
  if (cached) return cached
  if (glob.length > MAX_GLOB_LENGTH) {
    throw new Error(`Glob pattern longer than ${MAX_GLOB_LENGTH} characters`)
  }
  const normalised = glob.replace(/\\/g, "/")
  const regex = new RegExp(`^${compile(normalised, true, true)}$`)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(glob, regex)
  return regex
}

/** Does `path` (`/`-separated) match `glob`? */
export function matchesGlob(glob: string, path: string): boolean {
  return globRegExp(glob).test(path.replace(/\\/g, "/"))
}

/** Does `path`, or any directory above it, match `glob`? For excludes, which cover what is inside. */
export function matchesGlobOrParent(glob: string, path: string): boolean {
  const regex = globRegExp(glob)
  const normalised = path.replace(/\\/g, "/")
  if (regex.test(normalised)) return true
  for (
    let slash = normalised.indexOf("/", 1);
    slash !== -1;
    slash = normalised.indexOf("/", slash + 1)
  ) {
    if (regex.test(normalised.slice(0, slash))) return true
  }
  return false
}
