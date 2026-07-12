/**
 * HTTP Adapter Implementation
 *
 * Wraps the existing fetchWithTimeout logic and implements the FetcherAdapter interface.
 * This is the default adapter for standard HTTP requests.
 *
 * Usage Scenarios:
 * - CLI mode: snapshotting public websites
 * - Library mode: default choice when the user has no special authentication requirements
 */

import {
  type FetchOptions,
  type FetchResult,
  type AuthContext,
  type FetcherAdapter,
} from "./fetcher-adapter.js"
import { fetchWithTimeout } from "../fetcher.js"

/**
 * HTTP 适配器：使用 node-fetch 进行 HTTP 请求
 *
 * 特点：
 * - 简单高效，适合公开内容
 * - 无法处理需要浏览器 Cookie 的认证
 * - 适合作为 CLI 工具的默认后端
 *
 * 使用示例：
 * ```typescript
 * const adapter = new HttpFetcherAdapter();
 * const result = await adapter.fetch('https://example.com', {
 *   timeout: 15000,
 *   referer: 'https://google.com'
 * });
 * ```
 */
export class HttpFetcherAdapter implements FetcherAdapter {
  /**
   * Getting HTTP Resources
   *
   * Calls the existing fetchWithTimeout function and converts the result into a uniform FetchResult format.
   *
   * @param url The full URL of the resource
   * @param options Fetch options (timeout, referer, maxSize, etc.)
   * @returns FetchResult with buffer, MIME type, status code, etc.
   */
  async fetch(url: string, options: FetchOptions): Promise<FetchResult> {
    const result = await fetchWithTimeout(
      url,
      options.timeout ?? 15000,
      options.referer,
      options.maxSize
    )

    return {
      buffer: result.buffer,
      mime: result.mime,
      status: result.status,
      ok: result.ok,
      isHtmlLike: result.isHtmlLike,
      headers: {},
      url: url,
    }
  }

  /**
   * Checking if a resource is accessible
   *
   * Quick check: sends a request with a short timeout.
   * Returns true if the request was successful and the status code is 2xx.
   *
   * @param url The full URL of the resource
   * @returns true for a successful HTTP request (2xx), false for a failed request.
   */
  async canAccess(url: string): Promise<boolean> {
    try {
      const result = await this.fetch(url, { timeout: 5000 })
      return result.ok
    } catch {
      return false
    }
  }

  /**
   * Get Authentication Context
   *
   * The HTTP adapter does not handle authentication and returns an empty authentication context.
   * If you need to customize the request headers, you can pass them in via options.headers during the fetch() call.
   *
   * @returns empty authentication context
   */
  async getAuthContext(): Promise<AuthContext> {
    return {
      cookies: [],
      headers: {},
    }
  }

  /**
   * Liquidation of resources
   *
   * No special cleanup is required for HTTP adapters; this method is implemented as null.
   */
  async dispose(): Promise<void> {
    // HTTP adapters are stateless and do not require cleanup
  }
}
