import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

// Exercise native ESM hooks in an isolated process, as Logto's --import does.
test("only HTTP Email receives the bounded pool; other Got callers and HTTPError stay intact", () => {
  mkdirSync(join(process.cwd(), ".cache"), { recursive: true })
  const directory = mkdtempSync(join(process.cwd(), ".cache/logto-mail-loader-"))
  try {
    const preload = join(directory, "cognia-mail/preload.mjs")
    const library = join(directory, "packages/connectors/connector-http-email/lib")
    const dependency = join(directory, "node_modules/got")
    mkdirSync(join(directory, "cognia-mail"), { recursive: true })
    mkdirSync(library, { recursive: true })
    mkdirSync(dependency, { recursive: true })
    copyFileSync(new URL("./preload.mjs", import.meta.url), preload)
    copyFileSync(new URL("./client.mjs", import.meta.url), join(library, "cognia-client.mjs"))
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.mjs" })
    )
    writeFileSync(
      join(dependency, "index.mjs"),
      `
      export class HTTPError extends Error {}
      const original = { kind: "original", extend(options) { return {kind: "mail", options}; } };
      export {original as got}; export default original;
    `
    )
    writeFileSync(join(library, "index.js"), 'export {default, got, HTTPError} from "got";')
    writeFileSync(join(directory, "package.json"), '{"type":"module"}')
    const verification = join(directory, "verify.mjs")
    writeFileSync(
      verification,
      `
      import assert from "node:assert/strict";
      import ordinary, {HTTPError} from "got";
      import mail, {got, HTTPError as MailError} from "./packages/connectors/connector-http-email/lib/index.js";
      assert.equal(ordinary.kind, "original");
      assert.equal(mail.kind, "mail");
      assert.equal(mail, got);
      assert.equal(MailError, HTTPError);
      const agent = mail.options.agent.https;
      assert.equal(agent.options.keepAlive, true);
      assert.equal(agent.options.timeout, 90000);
      assert.equal(agent.maxSockets, 64);
      assert.equal(agent.maxFreeSockets, 32);
      assert.notEqual(agent.options.rejectUnauthorized, false);
      assert.equal(mail.options.timeout.request, 20000);
      assert.equal(mail.options.http2, undefined);
      assert.equal(mail.options.retry, undefined);
      assert.equal(mail.options.headers, undefined);
      agent.destroy();
    `
    )
    const result = spawnSync(process.execPath, ["--import", preload, verification], {
      encoding: "utf8",
      timeout: 15_000,
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
