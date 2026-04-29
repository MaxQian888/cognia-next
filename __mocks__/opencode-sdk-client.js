// Stub for @opencode-ai/sdk and its /client subpath. The published package is
// pure ESM with subpath exports that Jest's CommonJS resolver can't handle,
// and tests never exercise the OpenCode runtime — they only need the import
// graph to resolve.
//
// Every named export resolves to a noop function or undefined; consumers that
// destructure types/classes here will receive undefined, which is fine because
// types are erased and the runtime values are only used inside live OpenCode
// sessions (Tauri only).

const noop = () => undefined

class StubClient {}

module.exports = new Proxy(
  {
    createOpencodeClient: () => new StubClient(),
    createOpencodeServer: () => ({
      url: "http://localhost",
      close: noop,
    }),
    OpencodeClient: StubClient,
    OpencodeServer: StubClient,
    default: StubClient,
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop]
      // Any other named import resolves to a noop function — safe enough for
      // import resolution since tests never instantiate these.
      return noop
    },
  }
)
