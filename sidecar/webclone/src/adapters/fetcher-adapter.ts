/**
 * Unified resource acquisition adapter interface
 * Support for multiple backends: HTTP, Playwright, caching, etc.
 *
 * Design Principle:
 * - Abstract resource fetching logic, decouple the snapshot core from the specific HTTP implementation
 * - Supports multiple authentication and resource sources (HTTP, browser context, cache, etc.)
 * - Allow Playwright to integrate with other automation tools.
 */

/**
 * Options when fetching resources
 */
export interface FetchOptions {
  /**
   * Request timeout (milliseconds)
   * @default 15000
   */
  timeout?: number

  /**
   * Referer request header
   */
  referer?: string

  /**
   * Customized request headers
   */
  headers?: Record<string, string>

  /**
   * Maximum file size (bytes)
   * @default 0 (unlimited)
   */
  maxSize?: number

  /**
   * Whether to validate the SSL certificate
   * @default true
   */
  validateSSL?: boolean

  /**
   * Whether to follow redirects
   * @default true
   */
  followRedirects?: boolean
}

/**
 * Results of resource acquisition
 */
export interface FetchResult {
  /**
   * Resource content binary data
   */
  buffer: Buffer

  /**
   * MIME Type
   */
  mime: string

  /**
   * HTTP Status Code
   */
  status: number

  /**
   * Success or failure (2xx)
   */
  ok: boolean

  /**
   * Whether the text content is HTML-like (text/html, application/xhtml+xml, etc.)
   */
  isHtmlLike: boolean

  /**
   * response header
   */
  headers?: Record<string, string>

  /**
   * Final URL (after redirection)
   */
  url?: string
}

/**
 * Authentication Context
 * Used to pass authentication information between adapters
 */
export interface AuthContext {
  /**
   * Browser Cookie List
   */
  cookies?: Array<{ name: string; value: string }>

  /**
   * Custom request headers (e.g. Authorization)
   */
  headers?: Record<string, string>

  /**
   * Authentication tokens (JWT, OAuth, etc.)
   */
  token?: string
}

/**
 * 统一的资源获取适配器接口
 *
 * 实现示例：
 * - HttpFetcherAdapter: 使用 node-fetch 进行 HTTP 请求（默认）
 * - PlaywrightFetcherAdapter: 使用 Playwright 浏览器上下文
 * - CacheFetcherAdapter: 从本地缓存读取资源
 *
 * 使用方式：
 * ```typescript
 * const adapter = new HttpFetcherAdapter();
 * // 或
 * const adapter = new PlaywrightFetcherAdapter(page, context);
 *
 * const result = await adapter.fetch('https://example.com/style.css', {
 *   timeout: 15000,
 *   headers: { 'Accept': 'text/css' }
 * });
 *
 * if (result.ok) {
 *   console.log(`Fetched ${result.buffer.length} bytes of ${result.mime}`);
 * }
 * ```
 */
export interface FetcherAdapter {
  /**
   * Getting resources (HTML, CSS, JS, images, etc.)
   *
   * @param url The full URL of the resource
   * @param options Get options
   * @returns Get results, including buffers, MIME types, status codes, etc.
   * @throws Throw exceptions in case of network errors, timeouts, etc.
   */
  fetch(url: string, options: FetchOptions): Promise<FetchResult>

  /**
   * Checking if a resource is accessible
   *
   * Optional method. Used to pre-filter inaccessible resources.
   * Should be implemented efficiently and quickly (e.g. using HEAD requests or a simple canAccess check).
   *
   * @param url The full URL of the resource.
   * @returns true means the resource is accessible, false means it is not.
   * @default If not implemented, the caller should assume that the resource can be attempted to be accessed.
   */
  canAccess?(url: string): Promise<boolean>

  /**
   * Get the current authentication context
   *
   * Optional method. Returns the authentication information in the current adapter, including cookies, tokens, etc.
   * Used to extract the authentication state after a snapshot for subsequent use.
   *
   * Implementation Notes:
   * - HTTP adapter: returns an empty object or a custom request header
   * - Playwright adapter: Returns browser cookies and localStorage tokens.
   *
   * @returns Authentication context, including cookies, request headers, tokens, etc.
   * @default If not implemented, assumes no special authentication information.
   */
  getAuthContext?(): Promise<AuthContext>

  /**
   * Liquidation of resources
   *
   * Optional method. Called when the adapter is no longer in use to free up resources.
   * For example, closing browser connections, cleaning up temporary files, etc.
   *
   * Implementation Notes:
   * - HTTP adapter: usually no need to implement
   * - Playwright adapter: closes the page (but does not close the browser, managed by the caller)
   *
   * @default if not implemented, assuming no special cleanup is needed
   */
  dispose?(): Promise<void>
}
