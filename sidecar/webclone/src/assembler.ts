import { writeFile, mkdir } from "node:fs/promises"
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, extname } from "node:path"
import { type SnapshotOptions, type SnapshotResult, type AssetRef, type Asset } from "./types.js"
import { parseHtml } from "./parser/html-parser.js"
import { extractCssAssets } from "./parser/css-parser.js"
import { downloadAllAssets } from "./fetcher.js"
import { assembleSingleFile } from "./output/single-file.js"
import { assembleBundle } from "./output/bundle.js"
import { assembleConvert } from "./output/convert.js"
import { postDownloadValidation, isHtmlLike } from "./validators.js"
import { convert } from "./converter.js"
import { assessMemoryBudget, formatDegradationSummary } from "./memory-budget.js"
import { runPool } from "./worker/pool.js"
import type { FetcherAdapter } from "./adapters/fetcher-adapter.js"
import { HttpFetcherAdapter } from "./adapters/http-fetcher-adapter.js"
import { setSsrfPolicy, assertFetchTargetAllowed } from "./ssrf-guard.js"

async function fetchHtml(
  url: string,
  timeout: number,
  maxSize: number | undefined,
  adapter: FetcherAdapter
): Promise<string | null> {
  try {
    const result = await adapter.fetch(url, { timeout, maxSize })
    if (!result.ok) {
      process.stdout.write(`Warning: Origin returned HTTP ${result.status} for HTML page\n`)
      if (result.status >= 400 && (result.isHtmlLike || isHtmlLike(result.buffer))) {
        return result.buffer.toString("utf8")
      }
      return null
    }
    return result.buffer.toString("utf8")
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error"
    process.stdout.write(`Warning: Failed to fetch HTML: ${message}\n`)
    return null
  }
}

function dedupe<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((i) => {
    if (seen.has(i.url)) return false
    seen.add(i.url)
    return true
  })
}

function extractInlineCss(html: string): string {
  let css = ""
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let match
  while ((match = styleRegex.exec(html)) !== null) {
    css += match[1] + "\n"
  }
  return css
}

function extractInlineJs(html: string): string {
  let js = ""
  // Only matches <script> tags without the src attribute.
  // Ensure that src does not appear in tag attributes using negative first assertion
  const scriptRegex = /<script(?:\s+(?!src\b)[^>]*)*\s*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = scriptRegex.exec(html)) !== null) {
    js += match[1] + "\n"
  }
  return js
}

/**
 * Extract CSS and JS from downloaded assets
 */
function extractCssFromAssets(assets: Asset[]): string {
  return assets
    .filter((a) => a.type === "css" && a.status === "fetched")
    .map((a) => a.textContent || "")
    .filter(Boolean)
    .join("\n")
}

/**
 * Framework/library file path patterns for JS pre-filtering.
 */
const FRAMEWORK_PATTERNS = [
  /\/node_modules\//,
  /\/react(\.[a-z]+)?\.js$/,
  /\/vue(\.[a-z]+)?\.js$/,
  /\/angular(\.[a-z]+)?\.js$/,
  /\/jquery(\.[a-z]+)?\.js$/,
  /\/umi(\.[a-z]+)?\.js$/,
  /\/lodash(\.[a-z]+)?\.js$/,
  /\/moment(\.[a-z]+)?\.js$/,
  /\/antd(\.[a-z]+)?\.js$/,
  /\/babel(\.[a-z]+)?\.js$/,
  /\/webpack(\.[a-z]+)?\.js$/,
  /\.min\.js$/,
]

function isFrameworkCode(originUrl: string): boolean {
  return FRAMEWORK_PATTERNS.some((pattern) => pattern.test(originUrl))
}

function extractJsFromAssets(assets: Asset[]): string {
  const userCode = assets.filter(
    (a) => a.type === "js" && a.status === "fetched" && !isFrameworkCode(a.originUrl)
  )
  const frameworkCode = assets.filter(
    (a) => a.type === "js" && a.status === "fetched" && isFrameworkCode(a.originUrl)
  )

  if (frameworkCode.length > 0) {
    const userSize = userCode.reduce((s: number, a) => s + (a.size || 0), 0)
    const fwSize = frameworkCode.reduce((s: number, a) => s + (a.size || 0), 0)
    process.stdout.write(
      `  JS filter: ${userCode.length} user files (${fmt(userSize)}) + ${frameworkCode.length} framework files (${fmt(fwSize)}) filtered\n`
    )
  }

  return userCode
    .map((a) => a.textContent || "")
    .filter(Boolean)
    .join("\n")
}

/**
 * Async write assets with concurrency control and progress reporting.
 */
async function writeAssets(assets: Asset[], concurrency: number = 5): Promise<void> {
  const toWrite = assets.filter((a) => a.status === "fetched" && a.localPath)
  const total = toWrite.length
  if (total === 0) return

  const tasks = toWrite.map((a) => async (): Promise<void> => {
    const localPath = a.localPath
    if (!localPath) return // Safety check
    const dir = dirname(localPath)
    await mkdir(dir, { recursive: true })
    const dataUriContent = a.dataUri?.split(",")[1]
    const buf = dataUriContent
      ? Buffer.from(dataUriContent, "base64")
      : a.textContent
        ? Buffer.from(a.textContent, "utf8")
        : Buffer.alloc(0)
    await writeFile(localPath, buf)
  })

  await runPool(
    tasks,
    { concurrency: Math.max(2, Math.min(concurrency, 10)) },
    (_result, _idx, completedCount) => {
      if (completedCount % Math.max(1, Math.floor(total / 10)) === 0 || completedCount === total) {
        process.stdout.write(`  Writing assets: ${completedCount}/${total}\n`)
      }
    }
  )
}

/**
 * Basic Snapshot Functions - Pulling Directly Using HTTP
 * @public
 */
export async function snapshot(
  url: string,
  optionsWithoutUrl: Omit<SnapshotOptions, "url">
): Promise<SnapshotResult> {
  const options: SnapshotOptions = { ...optionsWithoutUrl, url } as SnapshotOptions
  // Establish the SSRF policy for this process, then validate the entry URL up
  // front (before any I/O) so a blocked target fails fast with a clear error.
  setSsrfPolicy({ allowPrivateHosts: options.allowPrivateHosts })
  assertFetchTargetAllowed(url, { allowPrivateHosts: options.allowPrivateHosts })
  const httpAdapter = new HttpFetcherAdapter()
  return snapshotInternal(options, httpAdapter)
}

/**
 * Internal Core Pipeline
 * @internal
 */
async function snapshotInternal(
  options: SnapshotOptions,
  adapter: FetcherAdapter
): Promise<SnapshotResult> {
  const timestamp = new Date().toISOString()

  process.stdout.write(`Fetching HTML from ${options.url}...\n`)
  const html = await fetchHtml(options.url, options.timeout, options.maxFileSize, adapter)
  if (!html) {
    throw new Error("Failed to retrieve page content")
  }

  process.stdout.write(`Parsing HTML for assets...\n`)
  const parsed = parseHtml(html, options.url)

  let allRefs: AssetRef[] = [...parsed.assets]

  for (const style of parsed.inlineStyles) {
    const refs = extractCssAssets(style.text, style.baseUrl)
    for (const r of refs) {
      allRefs.push({
        url: r.url,
        type: r.type === "css" ? "css" : r.type === "font" ? "font" : "img",
        origin: "style",
      })
    }
  }

  allRefs = dedupe(allRefs)

  const cssRefs = allRefs.filter((r) => r.type === "css")
  const cssContentMap = new Map<string, string>()

  // Parallel CSS fetch + recursive @import extraction
  if (cssRefs.length > 0) {
    interface CssFetchResult {
      url: string
      ok: boolean
      cssText?: string
      childRefs?: import("./parser/css-parser.js").CssAssetRef[]
    }

    const cssTasks = cssRefs.map((ref) => async (): Promise<CssFetchResult> => {
      try {
        const result = await adapter.fetch(ref.url, {
          timeout: options.timeout,
          maxSize: options.maxFileSize,
          referer: options.url,
        })
        if (result.ok) {
          const cssText = result.buffer.toString("utf8")
          const childRefs = extractCssAssets(cssText, ref.url)
          return { url: ref.url, ok: true, cssText, childRefs }
        }
        return { url: ref.url, ok: false }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error"
        process.stdout.write(`  CSS fetch skipped: ${ref.url} — ${message}\n`)
        return { url: ref.url, ok: false }
      }
    })

    const cssResults = await runPool(cssTasks, {
      concurrency: Math.max(2, Math.min(options.concurrency, 5)),
    })

    // Collect child refs sequentially (safe: no race conditions on allRefs)
    for (const r of cssResults) {
      if (r.ok && r.cssText && r.childRefs) {
        cssContentMap.set(r.url, r.cssText)
        for (const child of r.childRefs) {
          allRefs.push({
            url: child.url,
            type: child.type === "css" ? "css" : child.type === "font" ? "font" : "img",
            origin: `css:${r.url}`,
          })
        }
      }
    }
  }

  allRefs = dedupe(allRefs)

  process.stdout.write(`Downloading ${allRefs.length} assets (max: ${options.maxAssets})...\n`)
  const assets = await downloadAllAssets(allRefs, options, (asset, index, total) => {
    const icon = asset.status === "fetched" ? "✓" : "✗"
    process.stdout.write(
      `  ${icon} [${index}/${total}] ${asset.originUrl}${asset.error ? ` (${asset.error})` : ` (${fmt(asset.size)})`}\n`
    )
  })

  for (const a of assets) {
    if (a.type === "css" && a.status === "fetched" && !a.textContent) {
      const cached = cssContentMap.get(a.originUrl)
      if (cached) a.textContent = cached
    }
  }

  // Post-download integrity validation
  const validationFailures = postDownloadValidation(assets)
  if (validationFailures.length > 0) {
    process.stdout.write(`\nIntegrity validation warnings:\n`)
    for (const failure of validationFailures) {
      process.stdout.write(`  ⚠ ${failure.url}: ${failure.error}\n`)
    }
  }

  const stats = {
    total: assets.length,
    fetched: assets.filter((a) => a.status === "fetched").length,
    failed: assets.filter((a) => a.status === "failed").length,
    skipped: assets.filter((a) => a.status === "skipped").length,
    validationWarnings: validationFailures.length,
    totalBytes: assets.reduce((s, a) => s + a.size, 0),
  }

  process.stdout.write(`\nAssembling output (${options.mode} mode)...\n`)

  if (options.mode === "bundle") {
    mkdirSync(options.output, { recursive: true })
    assembleBundle(parsed.document, assets, options)

    await writeAssets(assets, options.concurrency)
  } else {
    const outputHtml = assembleSingleFile(parsed.document, assets, options)
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, outputHtml, "utf8")
  }

  // Handle component extraction if requested
  if (options.extractComponents) {
    process.stdout.write(`\nExtracting component structure...\n`)

    // Collect CSS and JS from multiple sources:
    // 1. Inline CSS/JS from original HTML
    let css = extractInlineCss(html)
    let js = extractInlineJs(html)

    // 2. Downloaded CSS/JS from assets (for comprehensive coverage)
    if (assets.length > 0) {
      const cssFromAssets = extractCssFromAssets(assets)
      const jsFromAssets = extractJsFromAssets(assets)
      css = css ? css + "\n" + cssFromAssets : cssFromAssets
      js = js ? js + "\n" + jsFromAssets : jsFromAssets
    }

    // In-memory budget assessment and degradation
    const budget = assessMemoryBudget(html, css, js)
    const degradations = formatDegradationSummary(budget)

    if (degradations.length > 0) {
      process.stdout.write(`⚠ Memory budget: ${degradations.join(", ")} — results may be partial\n`)
    }

    // If the HTML is marked as skip, the entire component extraction is skipped.
    if (budget.htmlStrategy === "skip") {
      process.stdout.write(
        `⚠ HTML too large (${(html.length / 1024 / 1024).toFixed(1)}MB), skipping component extraction\n`
      )
    } else {
      // Pass the downgrade policy to convert
      const convertOptions = {
        ...options,
        memoryBudget: budget,
      }

      process.stdout.write(`Converting to component structure...\n`)
      const converted = await convert(html, css, js, convertOptions)

      process.stdout.write(`Writing component output...\n`)
      const componentOutputDir =
        options.mode === "bundle" ? options.output + "/components" : options.output + "_components"

      const componentOptions = {
        ...options,
        output: componentOutputDir,
      }

      assembleConvert(converted, componentOptions)
    }
  }

  return { sourceUrl: options.url, timestamp, html: "", assets, stats }
}

/**
 * Run component extraction + codegen on an existing local bundle/single output
 * without re-fetching the URL. Reads index.html, assets/css/*.css, and
 * assets/js/*.js from the local directory, then runs the full conversion pipeline.
 */
export async function convertLocalSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  if (!options.convertLocal) {
    throw new Error("convertLocal option is required")
  }
  const localPath = options.convertLocal
  const timestamp = new Date().toISOString()

  if (!existsSync(localPath)) {
    throw new Error(`Local path not found: ${localPath}`)
  }

  // Detect mode: directory = bundle, .html file = single
  const isDir = statSync(localPath).isDirectory()
  const htmlPath = isDir ? join(localPath, "index.html") : localPath

  if (!existsSync(htmlPath)) {
    throw new Error(`No index.html found in ${localPath}`)
  }

  process.stdout.write(`Reading HTML from ${htmlPath}...\n`)
  const html = readFileSync(htmlPath, "utf8")

  // Collect CSS
  let css = extractInlineCss(html)
  if (isDir) {
    const cssDir = join(localPath, "assets", "css")
    const cssContent = readFilesRecursively(cssDir, ".css")
    if (cssContent) {
      css += cssContent
      // Count files for reporting
      const count = (cssContent.match(/\n/g) || []).length + 1
      process.stdout.write(`  Loaded CSS from ${count} blocks\n`)
    }
  }

  // Collect JS
  let js = extractInlineJs(html)
  if (isDir) {
    const jsDir = join(localPath, "assets", "js")
    const jsContent = readFilesRecursively(jsDir, ".js")
    if (jsContent) {
      js += jsContent
      const count = (jsContent.match(/\n/g) || []).length + 1
      process.stdout.write(`  Loaded JS from ${count} blocks\n`)
    }
  }

  // Memory budget assessment
  const budget = assessMemoryBudget(html, css, js)
  const degradations = formatDegradationSummary(budget)

  if (degradations.length > 0) {
    process.stdout.write(`⚠ Memory budget: ${degradations.join(", ")} — results may be partial\n`)
  }

  if (budget.htmlStrategy === "skip") {
    throw new Error(
      `HTML too large (${(html.length / 1024 / 1024).toFixed(1)}MB), cannot extract components`
    )
  }

  process.stdout.write(`Converting to component structure...\n`)
  const convertOptions: SnapshotOptions = {
    ...options,
    convertLocal: undefined,
  }
  const converted = await convert(html, css, js, convertOptions)

  process.stdout.write(`Writing component output...\n`)
  const componentOutputDir = isDir
    ? join(options.output, "components")
    : options.output.replace(/(\.html?)?$/i, "_components")

  const componentOptions = {
    ...options,
    output: componentOutputDir,
  }

  assembleConvert(converted, componentOptions)

  // Build stats from conversion result
  const componentList = Array.from(converted.components.values())

  // Use dummy assets to satisfy SnapshotResult type
  const assets: Asset[] = []

  return {
    sourceUrl: localPath,
    timestamp,
    html,
    assets,
    stats: {
      total: componentList.length,
      fetched: 0,
      failed: 0,
      skipped: 0,
      validationWarnings: 0,
      totalBytes: 0,
      stateful: componentList.filter((c) => c.type === "stateful").length,
      presentational: componentList.filter((c) => c.type === "presentational").length,
    },
  } as SnapshotResult
}

function readFilesRecursively(dir: string, ext: string): string {
  let result = ""
  if (!existsSync(dir)) return result
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      result += readFilesRecursively(fullPath, ext)
    } else if (entry.isFile() && extname(entry.name) === ext) {
      try {
        result += "\n" + readFileSync(fullPath, "utf8")
      } catch {
        // Skip unreadable files
      }
    }
  }
  return result
}

function fmt(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${["B", "KB", "MB", "GB"][i]}`
}
