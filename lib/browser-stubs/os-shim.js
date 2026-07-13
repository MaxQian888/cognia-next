// Browser-safe stand-in for Node's `os`, aliased for the client/static-export
// bundle (and the Turbopack dev-server graph) via `next.config.ts`.
//
// Unlike the other Node built-ins in `NODE_ONLY_MODULES` — which map to the
// empty `{}` stub because nothing reads them at eval — some third-party deps
// dragged into the browser graph call `os` *at module-evaluation time*. The
// concrete case: `@vercel/oidc` (pulled in transitively by `ai` →
// `@ai-sdk/gateway`) builds a module-level User-Agent constant with
// `os.platform()`/`os.arch()`/`os.hostname()`. Against the empty stub those are
// `undefined()` calls, so merely evaluating any module that imports `"ai"`
// throws `TypeError: os.platform is not a function` and takes down the whole
// bundle (or the dev SSR render). This shim returns inert browser values so
// eval-time probes succeed. No first-party browser code reads `os`.
const os = {
  EOL: "\n",
  devNull: "/dev/null",
  constants: {},
  platform: () => "browser",
  arch: () => "unknown",
  machine: () => "",
  type: () => "Browser",
  release: () => "",
  version: () => "",
  hostname: () => "localhost",
  homedir: () => "/",
  tmpdir: () => "/tmp",
  endianness: () => "LE",
  availableParallelism: () => 1,
  cpus: () => [],
  loadavg: () => [0, 0, 0],
  totalmem: () => 0,
  freemem: () => 0,
  uptime: () => 0,
  networkInterfaces: () => ({}),
  userInfo: () => ({ username: "", uid: -1, gid: -1, shell: null, homedir: "/" }),
  getPriority: () => 0,
  setPriority: () => {},
}

module.exports = os
