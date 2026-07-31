import { extname } from "node:path"
import { request as httpRequest } from "node:http"
import { request as httpsRequest, type RequestOptions } from "node:https"
import type { Agent, IncomingMessage } from "node:http"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { isValidCachedResponse, mimeFromExt, checkResourceFilter } from "./validators.js"
import {
  type AssetType,
  type Asset,
  type AssetRef,
  type SnapshotOptions,
  MAX_INLINE_SIZE,
} from "./types.js"
import { runPool } from "./worker/pool.js"
import { guardOutboundUrl } from "./ssrf-guard.js"

const MAX_REDIRECTS = 10

/**
 * Resolve proxy agent for a given URL based on environment variables.
 * Supports HTTPS_PROXY / HTTP_PROXY / NO_PROXY (and lowercase variants).
 */
function resolveProxyAgent(url: string): Agent | undefined {
  const urlObj = new URL(url)
  const host = urlObj.hostname
  const isHttps = urlObj.protocol === "https:"

  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? ""
  if (noProxy) {
    const noProxyList = noProxy.split(",").map((s) => s.trim())
    if (noProxyList.some((p: string) => host === p || host.endsWith("." + p))) {
      return undefined // bypass proxy
    }
  }

  const proxyUrl = isHttps
    ? (process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      "")
    : (process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      "")

  if (!proxyUrl) return undefined

  // HttpsProxyAgent for HTTPS targets (CONNECT tunnel through HTTP proxy)
  // HttpProxyAgent for HTTP targets (direct proxy forwarding)
  return isHttps
    ? (new HttpsProxyAgent(proxyUrl) as unknown as Agent)
    : (new HttpProxyAgent(proxyUrl) as unknown as Agent)
}

export interface FetchResult {
  buffer: Buffer
  mime: string
  status: number
  ok: boolean
  isHtmlLike: boolean
}

/**
 * Validate that a URL uses http or https protocol.
 */
function validateUrlScheme(url: string): void {
  try {
    const u = new URL(url)
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`Unsupported protocol: ${u.protocol}`)
    }
  } catch (err: unknown) {
    throw new Error(`Invalid URL: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }
}

/**
 * Normalize a single header value from http.IncomingHttpHeaders to string.
 */
function headerValue(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0]
  return val ?? ""
}

export async function fetchWithTimeout(
  url: string,
  timeout: number,
  referer?: string,
  maxSize?: number,
  redirectCount = 0
): Promise<FetchResult> {
  validateUrlScheme(url)
  // SSRF gate — enforced on the entry URL, every sub-resource, and (via the
  // recursive call below) every redirect target. This is the single choke
  // point all HTTP-adapter fetches funnel through.
  guardOutboundUrl(url)

  const urlObj = new URL(url)
  const isHttps = urlObj.protocol === "https:"
  const requestFn = isHttps ? httpsRequest : httpRequest

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  return new Promise<FetchResult>((resolve, reject) => {
    const proxyAgent = resolveProxyAgent(url)

    const options: RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(referer ? { Referer: referer } : {}),
      },
      signal: controller.signal,
      agent: proxyAgent,
    }

    const req = requestFn(options, (res: IncomingMessage) => {
      const statusCode = res.statusCode ?? 0

      // Handle redirects (up to MAX_REDIRECTS)
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        clearTimeout(timer)
        const redirectUrl = new URL(res.headers.location, url).href
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects for ${url}`))
          return
        }
        // Consume the response body to free memory, then follow redirect
        res.resume()
        fetchWithTimeout(redirectUrl, timeout, referer, maxSize, redirectCount + 1).then(
          resolve,
          reject
        )
        return
      }

      // Check Content-Length header before reading
      if (maxSize && maxSize > 0) {
        const cl = res.headers["content-length"]
        if (cl) {
          const size = parseInt(Array.isArray(cl) ? cl[0] : cl, 10)
          if (!isNaN(size) && size > maxSize) {
            clearTimeout(timer)
            res.resume() // drain to prevent memory leak
            reject(new SizeLimitError(size, maxSize))
            return
          }
        }
      }

      const chunks: Buffer[] = []
      let totalLength = 0

      res.on("data", (chunk: Buffer) => {
        totalLength += chunk.length
        if (maxSize && maxSize > 0 && totalLength > maxSize) {
          clearTimeout(timer)
          controller.abort()
          req.destroy()
          reject(new SizeLimitError(totalLength, maxSize))
          return
        }
        chunks.push(chunk)
      })

      res.on("end", () => {
        clearTimeout(timer)
        const buffer = Buffer.concat(chunks)
        const contentType = headerValue(res.headers["content-type"]) || mimeFromExt(url)

        resolve({
          buffer,
          mime: contentType,
          status: statusCode,
          ok: statusCode >= 200 && statusCode < 300,
          isHtmlLike: contentType.includes("text/html"),
        })
      })

      res.on("error", (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    req.on("error", (err: Error) => {
      clearTimeout(timer)
      if (err.name === "AbortError" || (err as any).code === "ABORT_ERR") {
        reject(new Error(`Timeout after ${timeout}ms`))
      } else {
        reject(err)
      }
    })

    req.end()
  })
}

/**
 * Calculate retry backoff delay with configurable initial/max values.
 * Uses exponential backoff: initialDelay * 2^attempt, capped at maxDelay.
 */
function retryDelay(attempt: number, initialDelay: number, maxDelay: number): number {
  return Math.min(initialDelay * Math.pow(2, attempt), maxDelay)
}

export class SizeLimitError extends Error {
  size: number
  limit: number
  constructor(size: number, limit: number) {
    super(`File too large: ${size} bytes (max ${limit})`)
    this.name = "SizeLimitError"
    this.size = size
    this.limit = limit
  }
}

function classifyAssetType(url: string, refType: AssetType): AssetType {
  if (refType !== "other") return refType
  const ext = extname(url.split("?")[0]).toLowerCase()
  if ([".css"].includes(ext)) return "css"
  if ([".js", ".mjs"].includes(ext)) return "js"
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico"].includes(ext))
    return "img"
  if ([".woff", ".woff2", ".ttf", ".otf", ".eot"].includes(ext)) return "font"
  if ([".mp4", ".webm", ".mp3", ".wav", ".mov"].includes(ext)) return "media"
  return "other"
}

export async function downloadSingleAsset(
  ref: AssetRef,
  options: SnapshotOptions,
  referer: string
): Promise<Asset> {
  const asset: Asset = {
    originUrl: ref.url,
    type: classifyAssetType(ref.url, ref.type),
    status: "pending",
    size: 0,
    mime: "",
  }

  const filterResult = checkResourceFilter(ref.url, options)
  if (filterResult.skip) {
    asset.status = "skipped"
    asset.error = filterResult.reason
    return asset
  }

  const maxAttempts = Math.max(1, options.retryCount)
  const maxSize = options.maxFileSize ?? 0

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fetchWithTimeout(ref.url, options.timeout, referer, maxSize)

      if (!result.ok) {
        asset.error = `HTTP ${result.status}`
        if (attempt < maxAttempts) {
          const delay = retryDelay(
            attempt,
            options.retryInitialDelay ?? 200,
            options.retryMaxDelay ?? 2000
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
        asset.status = "failed"
        return asset
      }

      const ext = extname(new URL(ref.url).pathname) || ".bin"
      const filePath = `asset${ext}`

      if (!isValidCachedResponse(filePath, result.mime, result.buffer)) {
        asset.error = "Content validation failed"
        if (attempt < maxAttempts) {
          const delay = retryDelay(
            attempt,
            options.retryInitialDelay ?? 200,
            options.retryMaxDelay ?? 2000
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
        asset.status = "failed"
        return asset
      }

      asset.status = "fetched"
      asset.size = result.buffer.length
      asset.mime = result.mime

      if (asset.type === "css" || asset.type === "js") {
        asset.textContent = result.buffer.toString("utf8")
      }

      if (options.inline && asset.type !== "css" && asset.type !== "js") {
        if (result.buffer.length <= MAX_INLINE_SIZE) {
          asset.dataUri = `data:${result.mime};base64,${result.buffer.toString("base64")}`
        }
      }

      return asset
    } catch (err: unknown) {
      if (err instanceof SizeLimitError) {
        asset.status = "skipped"
        asset.error = err.message
        return asset
      }
      const message = err instanceof Error ? err.message : String(err)
      asset.error = message
      if (attempt < maxAttempts) {
        const delay = retryDelay(
          attempt,
          options.retryInitialDelay ?? 200,
          options.retryMaxDelay ?? 2000
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
      asset.status = "failed"
      return asset
    }
  }

  asset.status = "failed"
  return asset
}

export async function downloadAllAssets(
  refs: AssetRef[],
  options: SnapshotOptions,
  onProgress?: (asset: Asset, index: number, total: number) => void
): Promise<Asset[]> {
  const total = refs.length

  // Wrap each download operation as a separate task factory function
  const tasks = refs.map((ref) => () => downloadSingleAsset(ref, options, options.url))

  // Calculate pool timeout more accurately
  // Single resource can take: timeout * (retryCount + 1) + retry delays
  const perResourceTimeoutMs =
    options.timeout * (options.retryCount + 1) +
    options.retryCount * (options.retryMaxDelay ?? 2000)
  // Estimate total time based on resource count and concurrency
  const estimatedTotalMs = Math.min(
    120 * 1000, // Cap at 120s for safety
    perResourceTimeoutMs *
      Math.ceil(Math.max(1, Math.min(total, options.maxAssets)) / options.concurrency)
  )

  const results = await runPool(
    tasks,
    {
      concurrency: options.concurrency,
      maxTasks: options.maxAssets,
      timeoutMs: estimatedTotalMs,
    },
    (asset, _idx, completedCount) => {
      onProgress?.(asset, completedCount, total)
    }
  )

  return results.filter(Boolean)
}
