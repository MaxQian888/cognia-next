#!/usr/bin/env node
// Builds the cloud-document P0 native acceptance fixture (./entry.tsx) into a
// standalone page. The production search/staging/intake/preparation/proxy-fetch
// modules are bundled as-is; the provider registry and host-only modules are
// replaced by the in-memory stubs below.
//
//   node scripts/smoke/fixtures/cloud-docs-p0/build.mjs            → .cache/cloud-docs-p0/ui-fixture/public
//   node scripts/smoke/fixtures/cloud-docs-p0/build.mjs --public   → public/.p0-native-fixture (served by `pnpm dev`)
//   add --force to replace an existing output directory
//
// The --public output is gitignored and must be removed after the run: anything
// left under public/ ships in the static export.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(here, "../../../..")

export const CACHE_OUTPUT = ".cache/cloud-docs-p0/ui-fixture/public"
export const PUBLIC_OUTPUT = "public/.p0-native-fixture"

const INDEX_HTML =
  '<!doctype html><html><meta charset="UTF-8"><title>P0 native fixture</title><style>body{font:16px system-ui;margin:24px auto;padding:16px;max-width:1000px}button,select,textarea{font:inherit;padding:8px;margin:5px}output,pre{display:block;padding:8px}textarea{width:90%;min-height:60px}</style><div id="root"></div><script src="./bundle.js"></script></html>'

/** Parses CLI flags into the output directory and whether to replace it. */
export function parseArgs(argv, root = repoRoot) {
  const known = new Set(["--public", "--force"])
  const unknown = argv.filter((arg) => !known.has(arg))
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(" ")}`)
  return {
    output: path.join(root, argv.includes("--public") ? PUBLIC_OUTPUT : CACHE_OUTPUT),
    force: argv.includes("--force"),
  }
}

/** Module stubs keyed by import specifier; `root` pins the real modules they wrap. */
export function fixtureModules(root = repoRoot) {
  const real = (rel) => JSON.stringify(path.join(root, rel))
  return {
    "@/lib/docs-providers": `export * from ${real("lib/docs-providers/types.ts")};
const fixture = window.p0Fixture = {accounts:[{id:'a',label:'Fixture A',authorizationEpoch:'a1'},{id:'b',label:'Fixture B',authorizationEpoch:'b1'}],listeners:new Set(),holdSearch:false,holdFetch:false,holdPrep:false,empty:false,searches:[],fetches:[],preparations:[],notify(){for(const f of this.listeners)f()},releaseSearch(){for(const f of this.searches.splice(0))f()},releaseFetch(){for(const f of this.fetches.splice(0))f()},releasePrep(){for(const f of this.preparations.splice(0))f()}};
const provider={id:'p0',mentionPrefix:'p0:',kinds:['doc'],hosts:['tauri'],listAccounts:async()=>fixture.accounts,matchRef:()=>null,subscribeAccounts:(f)=>{fixture.listeners.add(f);return()=>fixture.listeners.delete(f)},search:async(q,opts)=>{if(fixture.holdSearch)await new Promise(resolve=>fixture.searches.push(resolve));return [{providerId:'p0',kind:'doc',id:'doc-'+opts.accountId,title:'Spec '+opts.accountId}]},fetch:async(ref)=>{if(fixture.holdFetch)await new Promise(resolve=>fixture.fetches.push(resolve));return {ref,title:ref.title,text:fixture.empty?'  ':'Fixture document body',format:'markdown',completeness:{status:'partial',reasons:['inaccessible-block']}}}};
export function docsProviderPrefixes(){return ['p0:']} export function getDocsProviderByPrefix(){return provider} export function getDocsProvider(id){return id==='p0'?provider:null}`,
    "@/lib/chat/mentions/entity-sources": `export function entityMentionPrefixes(){return []}export function entityMentionShortcuts(){return []}`,
    "@/hooks/use-host-profile": `export function useHostProfile(){return 'desktop'}`,
    "@/lib/chat/attachments/prepare": `export * from ${real("lib/chat/attachments/prepare.ts")};import {prepareComposerAttachments as real} from ${real("lib/chat/attachments/prepare.ts")};export async function prepareComposerAttachments(...args){const fixture=window.p0Fixture;if(fixture.holdPrep)await new Promise(resolve=>fixture.preparations.push(resolve));return real(...args)}`,
    "@/lib/chat/smart-snapshot": `export async function captureSmartSnapshotFiles(){throw new Error('fixture snapshot unsupported')}`,
    "@/lib/chat/smart-snapshot-command": `export function registerSmartSnapshotComposer(){return ()=>{}}`,
    "@/lib/tauri/pet-window": `export async function showMainWindow(){}`,
    "@/components/mobile/chat/composer-attachment": `export async function attachmentToFiles(){return []}`,
    "@/stores/system": `export const useProxyStore={getState:()=>({config:{mode:'off'}})};export function getActiveProxyUrl(){return null}export function getNetworkProxy(){return {bypass:[]}}`,
    "@/lib/tauri": `export function isTauri(){return !!window.__TAURI_INTERNALS__}`,
  }
}

export async function buildFixture({ output, force }, root = repoRoot) {
  if (fs.existsSync(output)) {
    if (!force)
      throw new Error(`fixture output already exists (pass --force to replace): ${output}`)
    fs.rmSync(output, { recursive: true, force: true })
  }
  fs.mkdirSync(output, { recursive: true })
  const modules = fixtureModules(root)
  const { build } = await import("esbuild")
  await build({
    entryPoints: [path.join(here, "entry.tsx")],
    outfile: path.join(output, "bundle.js"),
    bundle: true,
    platform: "browser",
    jsx: "automatic",
    absWorkingDir: root,
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "fixture-ports",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            modules[args.path] ? { path: args.path, namespace: "fixture" } : undefined
          )
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: modules[args.path],
            loader: "tsx",
            resolveDir: root,
          }))
        },
      },
    ],
  })
  fs.writeFileSync(path.join(output, "index.html"), INDEX_HTML)
  return output
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  buildFixture(parseArgs(process.argv.slice(2)))
    .then((output) => console.log("Built P0 native fixture:", output))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
