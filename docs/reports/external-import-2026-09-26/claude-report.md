# Claude Code history parsing — measured owner lookup optimization

The retained change removes repeated member-by-task scans during Claude Code Agent Teams history reconstruction. It builds a task-owner index once per snapshot, lazily when the first eligible member needs it. Each member resolves its display name and agent ID, keeping the earlier original task position when both match. Complexity changes from O(members × tasks) to O(members + tasks).

Only `lib/session-import/adapters/claude-code.ts` and its colocated test changed. DAG selection, transcript parsing, content mapping, scan cache lifecycle, independent subagents, canonical conversion, input limits and redaction remain the existing implementations.

## Accepted end-to-end evidence

Complete real-file `parseGraph` batch: transcript reads, JSON parsing, DAG conversion, child artifact reads, team/task filesystem walk and reads, canonical graph construction. This is **not** a claim about raw JSON.parse speed, Tauri IPC or persistence/UI latency.

| File-backed workload | Before median ms | After median ms |  Change | MAD before / after ms |
| -------------------- | ---------------: | --------------: | ------: | --------------------: |
| long                 |           54.137 |          53.770 |  -0.68% |         2.316 / 2.687 |
| large-tools          |          162.335 |         163.029 |  +0.43% |         4.801 / 1.065 |
| teams                |          308.620 |         175.613 | -43.10% |       13.882 / 10.217 |
| small                |            0.771 |           0.798 |  +3.58% |         0.099 / 0.203 |
| single-owner         |          136.730 |         140.754 |  +2.94% |         3.586 / 7.958 |

The intended `teams` workload saves 133.007 ms (43.10%), exceeding both the pre-registered 10% threshold and twice the larger MAD (27.764 ms). Long ordinary history and large tool-result parsing remain within noise; **no speedup is claimed for them**. The small and single-owner guards do not materially regress.

Retained team graph heap delta after explicit GC: 21,690,056 → 21,683,012 bytes. Absolute retained process heap median: 29,910,892 → 29,971,448 bytes. These are shared-process Node GC measurements, not allocation counts or desktop peak RSS. Raw transient heap/RSS observations are also retained; no peak-memory reduction claim is made.

## Workloads and measurement boundaries

- Apple M4 Pro, macOS26.5.2, Nodev26.5.0; bundled actual TypeScript source with esbuild. Existing source dependencies identical between variants; baseline adapter taken from `5d48f846142312c8d344083b5240d32400b36946` using esbuild `onLoad` without reverting working files.
- `teams`: 16 transcript files ×100 records;160 members;4,000 task JSON files; same fresh input object shared across the16 references, exercising existing input-scoped corpus reuse. Owners for active members appear after3,840 historical tasks. Total935,226 bytes across4,017 files.
- `long`:12,000 linked records, user text, assistant reasoning and tools.
- `large-tools`:600 tool results ×16KiB plus reasoning, abandoned branch, inline sidechain, two resumed independent child files, and malformed trailing JSONL. All output is retained.
- `small`:20 records. `single-owner`:100 records,4,000 task files,1 member whose matching task is first, to guard against full index construction overwhelming an easy ownership lookup.
- Two warmups per variant, then12 AB/BA paired iterations. Warm filesystem cache; fixture creation, graph JSON hashing, GC and event-loop yield are outside timed intervals. Complete graph JSON SHA256 equality checked in every iteration. No user history files, credentials or external services used.
- Each measured batch uses a fresh `SessionScanInput`; this experiment adds no cache or stale-read exposure. Files are real temp-directory artifacts, removed afterward. Native filesystem/UI transport is not exercised.
- Final accepted source SHA256: `457dd81d8c6989fe186c16b9c81456d9d881caf26517c0cbe5292350e0602f82`. Both accepted main and single-owner artifacts match this hash.

## Decision ledger and noise

1. Per-record temporary array/filter removal: long52.55→51.92ms and tool-heavy163.64→163.25ms, below10% and within noise. Removed; `claude-loop-results.json` retains the negative result.
2. Full owner index initially measured283.09→149.94ms, withMAD6.41/9.69ms (`claude-owner-results.json`). That source hash differs only because Prettier subsequently changed a type-union line layout. It is historical evidence, not the quoted final measurement.
3. A rerun with corrected retained-heap measurement and high shared-machine load measured406.18→257.77ms, MAD96.99/35.56ms. It **failed the pre-registered noise rule** and is explicitly inconclusive (`claude-noisy-results.json`). No best-sample selection was used.
4. After coordinating the agent team's measurement interval, the final complete paired run passed at308.62→175.61ms (`claude-results.json`). Unrelated workstation load remains outside our control; between-run variation is why these are local workload measurements, not an SLA.
5. A progressive prefix-index variation was withdrawn to avoid keeping complexity without a demonstrated end-to-end guardrail benefit (`claude-prefix-withdrawn-results.json`). The accepted implementation remains the simpler full owner index. The separately measured final single-owner guard shows only+2.94%, within noise (`claude-single-owner-results.json`).

## Verification and reproduction

`node_modules/.bin/jest lib/session-import/adapters/claude-code.test.ts --runInBand`: **30 passed**. New regressions cover first task across name/agent-ID aliases, missing alias fields/unowned tasks, duplicate task IDs with final-owner semantics, unmatched owners, and fresh filesystem transcript/task reads in a new scan input. Existing tests cover branches, sidechains, independent/resumed agents, complete tools, malformed records and redacted unknown diagnostics.

Focused ESLint and formatting passed. Parent coordinates shared type checks; no standalone full-project typecheck claim is made here.

```sh
rtk proxy node --expose-gc docs/reports/external-import-2026-09-26/claude-measure.mjs
```

This rebuilds both source variants and measures all five workloads. `CLAUDE_WORKLOAD=single-owner` selects just the guard. The retained main `claude-results.json` covers the original four; `claude-single-owner-results.json` is the subsequent pre-registered guard. Raw samples, SHA256 outputs, source hashes, medians, MAD and heap observations are in those files; the original contract is `claude-contract.md`.

## Final-source refresh after picker isolation fix

`claude-final-results.json` reruns the unchanged workload matrix against the final Claude adapter, SHA-256 `8f97e412108a55a42995de2aeb0859631c657f437875430638ab0da6038f5057`, preserved in `claude-final.ts`. All full-output hashes match. Team/task workload: 308.059 ± 9.885 ms to 158.753 ± 4.357 ms (**48.47%**), passing both thresholds. Long: 54.515 to 54.646 ms; large tools: 165.248 to 164.911 ms; small: 0.723 to 0.709 ms, all neutral. Single-owner 192.209 ± 14.013 to 172.380 ± 16.221 ms is **inconclusive** because the median delta is below twice the larger MAD. Use this refresh for the final implementation, preserving earlier runs as experiment history.
