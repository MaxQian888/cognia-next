/**
 * Dependency-free startup safety net. The regular boot probe and logger depend
 * on application modules; neither can report a missing application bundle.
 * This script must execute as a native inline script, before the Next runtime.
 * Like every browser timer it cannot run while the main thread is fully blocked.
 */
export const STARTUP_RECOVERY_TIMEOUT_MS = 20_000
export const STARTUP_RECOVERY_STORAGE_KEY = "cognia.startup-diagnostic.v1"

export interface StartupRecoveryMessages {
  title: string
  description: string
  reload: string
}

declare global {
  interface Window {
    __COGNIA_STARTUP_RECOVERY__?: { complete: () => void }
  }
}

/** The account initializer hands subsequent loading/error UI back to React. */
export function markStartupReactReady(): void {
  if (typeof window !== "undefined") window.__COGNIA_STARTUP_RECOVERY__?.complete()
}

/**
 * Keep the executable source literal: serializing a transpiled function with
 * toString() can retain compiler helpers or minified module-local references.
 * Only the small locale payload is interpolated, escaped for an HTML script.
 */
export function createStartupRecoveryScript(messages: StartupRecoveryMessages): string {
  const config = JSON.stringify({
    messages,
    timeoutMs: STARTUP_RECOVERY_TIMEOUT_MS,
    storageKey: STARTUP_RECOVERY_STORAGE_KEY,
    e2e: process.env.NEXT_PUBLIC_E2E === "1",
    buildCommit: /^[a-f0-9]{7,40}$/i.test(process.env.NEXT_PUBLIC_GIT_COMMIT ?? "")
      ? process.env.NEXT_PUBLIC_GIT_COMMIT
      : null,
    buildTime: /^\d{4}-\d{2}-\d{2}T[\d:.+-]{1,32}Z?$/.test(process.env.NEXT_PUBLIC_BUILD_TIME ?? "")
      ? process.env.NEXT_PUBLIC_BUILD_TIME
      : null,
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")

  return `;(function (config) {
  if (window.__COGNIA_STARTUP_RECOVERY__) return;
  // Match the lightweight route shell, including static-export .html URLs.
  var path = window.location.pathname;
  var routes = ['/status', '/logto/callback', '/pet-overlay', '/pet-popup', '/island', '/selection-toolbar', '/tray-panel', '/recorder-controller', '/prototype'];
  if (config.e2e) routes.push('/e2e/plugin-ui-surfaces');
  for (var i = 0; i < routes.length; i++) {
    var route = routes[i];
    if (path === route || path === route + '.html' || path.indexOf(route + '/') === 0) return;
  }
  var startedAt = Date.now();
  var done = false;
  var panel = null;
  var events = [];
  var state = 'waiting';
  var timedOut = false;
  function persist() {
    try {
      // Content-free allowlist: never read messages, stacks, arbitrary URLs,
      // rejection reasons, account data, query strings or fragments.
      window.sessionStorage.setItem(config.storageKey, JSON.stringify({
        version: 1, startedAt: startedAt, state: state, timedOut: timedOut,
        buildCommit: config.buildCommit, buildTime: config.buildTime,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        readyState: document.readyState,
        online: window.navigator.onLine !== false,
        events: events
      }));
    } catch (_) {}
  }
  function nextAsset(source) {
    if (typeof source !== 'string' || !source) return null;
    try {
      var url = new window.URL(source, window.location.href);
      if (url.origin !== window.location.origin) return null;
      var pathname = url.pathname;
      if (pathname.indexOf('/_next/static/') !== 0 || pathname.length > 320) return null;
      // Only deployment-generated paths; query/hash are deliberately omitted.
      if (!/^[/A-Za-z0-9_.~%()@+-]+$/.test(pathname)) return null;
      return pathname;
    } catch (_) { return null; }
  }
  function record(kind, asset, errorClass, line, column) {
    if (done || events.length >= 8) return;
    var entry = { kind: kind, elapsedMs: Math.max(0, Date.now() - startedAt) };
    if (asset) entry.asset = asset;
    if (errorClass) entry.errorClass = errorClass;
    if (typeof line === 'number' && isFinite(line) && line > 0 && line <= 100000000) entry.line = Math.floor(line);
    if (typeof column === 'number' && isFinite(column) && column > 0 && column <= 100000000) entry.column = Math.floor(column);
    events.push(entry);
    persist();
  }
  function onError(event) {
    var target = event.target;
    if (target && target !== window) {
      var tag = target.tagName;
      if (tag === 'SCRIPT') record('script-resource', nextAsset(target.src));
      else if (tag === 'LINK' && target.rel === 'stylesheet') record('stylesheet-resource', nextAsset(target.href));
      return;
    }
    var errorClass = null;
    try {
      var name = event.error && event.error.name;
      if (/^(Error|TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError|AggregateError)$/.test(name)) errorClass = name;
    } catch (_) {}
    record('runtime-error', nextAsset(event.filename), errorClass, event.lineno, event.colno);
  }
  function onRejection() { record('promise-rejection'); }
  function show() {
    if (done || panel) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', show, { once: true });
      return;
    }
    panel = document.createElement('section');
    panel.id = 'cognia-startup-recovery';
    panel.setAttribute('role', 'alert');
    panel.setAttribute('aria-labelledby', 'cognia-startup-recovery-title');
    panel.style.cssText = 'position:fixed;z-index:2147483647;inset:auto 16px 16px;margin:0 auto;max-width:560px;padding:24px;border:1px solid #525252;border-radius:16px;background:#171717;color:#fafafa;box-shadow:0 12px 48px #0008;font:16px/1.5 system-ui,sans-serif;';
    var title = document.createElement('h2');
    title.id = 'cognia-startup-recovery-title';
    title.textContent = config.messages.title;
    title.style.cssText = 'font:600 20px/1.3 system-ui,sans-serif;margin:0 0 12px;';
    var detail = document.createElement('p');
    detail.textContent = config.messages.description;
    detail.style.cssText = 'margin:0 0 16px;color:#d4d4d4;';
    var reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = config.messages.reload;
    reload.style.cssText = 'font:inherit;padding:8px 16px;border:1px solid #a3a3a3;border-radius:8px;background:#fafafa;color:#171717;cursor:pointer;';
    reload.addEventListener('click', function () { window.location.reload(); });
    panel.appendChild(title);
    panel.appendChild(detail);
    panel.appendChild(reload);
    document.body.appendChild(panel);
  }
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  var timer = window.setTimeout(function () {
    if (done) return;
    state = 'timed-out';
    timedOut = true;
    persist();
    show();
  }, config.timeoutMs);
  window.__COGNIA_STARTUP_RECOVERY__ = {
    complete: function () {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      document.removeEventListener('DOMContentLoaded', show);
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onRejection);
      if (panel) panel.remove();
      // Retain evidence of an unhealthy start across a manual reload without
      // writing a snapshot on healthy starts that had no early errors.
      if (events.length || state === 'timed-out') {
        state = 'react-ready';
        persist();
      }
    }
  };
})(${config});`
}
