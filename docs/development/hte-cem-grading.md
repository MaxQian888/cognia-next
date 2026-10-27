# Offline HTE CEM grading

`scripts/eval/hte_cem_grader.py` grades retained `cross-entropy-method` artifacts
without starting Cognia, a relay, a provider client, or a model request. The prior
HTE scorer exists in sealed campaign caches; changing it would invalidate the
historical execution manifests. This separate entry is used by offline regrades
and should be used for CEM grading in future campaigns.

## Trusted inputs and execution

Use an absolute interpreter path for the campaign's existing Python environment
containing pytest and numpy. The
grader requires macOS `sandbox-exec`. The task source manifest must bind the
original admission hashes for these five task-relative files:

- `tests/test_outputs.py`
- `evaluation_tests_hidden/test_q1_pointenv_step.py`
- `evaluation_tests_hidden/test_q2_cross_entropy_optimize.py`
- `evaluation_tests_hidden/test_q3_evaluate_plans.py`
- `evaluation_tests_hidden/test_q4_caching_performance.py`

Extract these hashes from the pinned campaign manifest; do not replace them with
hashes recomputed from potentially modified test files.

```sh
"$COGNIA_EVAL_PYTHON" -I -B scripts/eval/hte_cem_grader_test.py -v

"$COGNIA_EVAL_PYTHON" -I -B scripts/eval/hte_cem_grader.py grade \
  --task-dir "$COGNIA_EVAL_TASK_DIR" \
  --workspace "$COGNIA_EVAL_RETAINED_WORKSPACE" \
  --output-dir "$COGNIA_EVAL_NEW_RESULT_DIR" \
  --python "$COGNIA_EVAL_PYTHON" \
  --source-manifest "$COGNIA_EVAL_ADMITTED_TEST_MANIFEST" \
  --timeout-seconds 180
```

The output directory must not exist or overlap the retained workspace or task
source. Nothing is installed. The CLI returns zero only for a complete behavioral
pass; inspect `result.json.validGrading` to distinguish assertion failures from an
incomplete or invalid grader run.

## Discovery and permission boundary

The grader copies only the candidate's regular `cross_entropy_method` package
files into a private grading directory, without executing the retained workspace.
Candidates depending on other workspace helpers need a separately reviewed
projection; the six audited A/B CEM packages have no such dependencies.

The trusted task projection retains sibling `tests/` and
`evaluation_tests_hidden/` directories. Hidden source bytes remain identical to
the admission manifest. Only the existing `/app` and `/tests` host path
substitutions are applied to the public entry. Collection must contain the exact
three public and nineteen hidden functions, with matching module/file/code
identities. Missing modules, silently swallowed import errors, or a three-test
fallback cannot produce a pass.

Python runs isolated with bytecode writes disabled. Trusted pytest and numpy are
loaded before candidate imports; plugin autoload, workspace conftest/config, and
pytest assertion rewriting are disabled. Plain assertions preserve the original
test expressions and allow direct code-object identity checks. Raw `marshal`
serialization is not a canonical code fingerprint and is deliberately avoided.

The worker can read its private task/candidate projection and trusted runtime. It
cannot write the candidate, original workspace, or trusted tests; writes are
restricted to private scratch. Network and process fork are denied. Existing
agent policies are not widened: hidden tests, private grader output, and the new
entry remain outside their readable roots. Validate direct and symlink reads
with positive ordinary-file controls when integrating a new campaign.

This boundary covers the six source-audited snapshots. The same Python process
executes tests and candidate code, so it is not an arbitrary malicious-Python
anti-cheat certification. Grader results include collection identities, all
setup/call/teardown records, completion status, integrity checks, and runtime
versions; none of these replace source review for adversarial submissions.

## Additive results

Keep old result rows, test logs, workspaces, request telemetry, and execution
manifests unchanged. Store regrades in a fresh directory and preserve failed
preparation attempts separately. Evaluate each artifact once without random or
timing retries to obtain a passing result: the original optimizer tests contain
stochastic checks, and the caching speedup assertion depends on host timing.

Record these independently:

- Original task success, clean exit, timeout, wall time, tokens and costs.
- Offline grader validity, twenty-two test results, behavioral pass and duration.
- A diagnostic strict overlay requiring the **original** clean exit and input
  integrity in addition to the new behavioral pass.

A timed-out attempt stays a task failure even if its retained artifact later
passes every offline test. The overlay never overwrites historical scores and
does not represent a fresh model run.
