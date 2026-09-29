export class RemoteBrowserError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "RemoteBrowserError"
    this.code = code
  }
}
