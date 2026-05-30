// Typed errors for the WebDAV client. Carrying the HTTP status lets callers
// branch (404 → "no snapshot yet", 401/403 → "bad credentials") without
// string-matching messages.

export class WebDavError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "WebDavError"
    this.status = status
  }
}

/** A resource (collection or file) was not found (HTTP 404). */
export class WebDavNotFoundError extends WebDavError {
  constructor(message = "WebDAV resource not found") {
    super(message, 404)
    this.name = "WebDavNotFoundError"
  }
}

/** Authentication / authorization failed (HTTP 401 / 403). */
export class WebDavAuthError extends WebDavError {
  constructor(message = "WebDAV authentication failed", status = 401) {
    super(message, status)
    this.name = "WebDavAuthError"
  }
}
