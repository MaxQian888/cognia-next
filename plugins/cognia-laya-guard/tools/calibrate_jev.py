"""Score laya on the reply copilot's judge questions (ADR-0194).

Runs jev-chat-jarvis's 30-case labeled set (vendored in
``tools/fixtures/jev_labeled_set.json``, MIT) through the local engine with the
copilot's COMPACT question wording (``tools/jev_compact_questions.json``,
exported from ``lib/reply-copilot/questions.ts`` and pinned by its test), and
reports Jarvis's own acceptance bar:

* ``danger_level`` mean absolute error < 1.0 level
* ``true_intent`` and ``she_needs`` hit rate >= 60%

plus the hit rate of every other question. Opt-in: needs the plugin venv
(torch + laya) and the cached weights::

    plugins/cognia-laya-guard/.venv/bin/python plugins/cognia-laya-guard/tools/calibrate_jev.py

``score_cases`` is pure so the suite can test the metrics with a fake engine.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
FIXTURE = HERE / "fixtures" / "jev_labeled_set.json"
QUESTIONS = HERE / "jev_compact_questions.json"

NOUL_KEYS = ("literal_question", "should_reply_now", "tension_resolved")
CHOICE_KEYS = ("true_intent", "best_action", "she_needs")
SCORE_KEY = "danger_level"

#: Jarvis docs/acceptance.md section C.
DANGER_MAE_BAR = 1.0
CHOICE_HIT_BAR = 0.6
GATED_CHOICES = ("true_intent", "she_needs")


def build_state(case: Dict[str, Any]) -> Dict[str, Any]:
    messages = case["messages"][-10:]
    return {
        "chat": {
            "relationship": case.get("relationship") or "unspecified",
            "messages": messages,
            "latest_from": messages[-1]["from"] if messages else "other",
        }
    }


def score_cases(
    cases: List[Dict[str, Any]],
    questions: Dict[str, Any],
    decide: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
) -> Dict[str, Any]:
    """Run every case through ``decide`` and aggregate per-question metrics."""
    hits: Dict[str, List[bool]] = {key: [] for key in NOUL_KEYS + CHOICE_KEYS}
    danger_errors: List[float] = []
    failures: List[Dict[str, str]] = []
    rows: List[Dict[str, Any]] = []
    for case in cases:
        out = decide(build_state(case), questions)
        if not out.get("ok"):
            failures.append({"id": case["id"], "error": json.dumps(out.get("error"))})
            continue
        answers = out["answers"]
        expect = case["expect"]
        row: Dict[str, Any] = {"id": case["id"]}
        for key in NOUL_KEYS:
            p = answers.get(key, {}).get("noul")
            if p is None:
                continue
            got = p >= 0.5
            hits[key].append(got == bool(expect[key]))
            row[key] = round(p, 3)
        for key in CHOICE_KEYS:
            choice = answers.get(key, {}).get("choice")
            if choice is None:
                continue
            hits[key].append(choice == expect[key])
            row[key] = choice
        score = answers.get(SCORE_KEY, {}).get("score")
        if score is not None:
            danger_errors.append(abs(float(score) - float(expect[SCORE_KEY])))
            row[SCORE_KEY] = round(float(score), 2)
        rows.append(row)

    def rate(values: List[bool]) -> Optional[float]:
        return round(sum(values) / len(values), 3) if values else None

    hit_rates = {key: rate(values) for key, values in hits.items()}
    danger_mae = round(sum(danger_errors) / len(danger_errors), 3) if danger_errors else None
    passes = {
        "danger_level": danger_mae is not None and danger_mae < DANGER_MAE_BAR,
        **{key: (hit_rates[key] or 0.0) >= CHOICE_HIT_BAR for key in GATED_CHOICES},
    }
    return {
        "cases": len(cases),
        "answered": len(rows),
        "failures": failures,
        "hitRates": hit_rates,
        "dangerMae": danger_mae,
        "passes": passes,
        "passed": all(passes.values()) and not failures,
        "rows": rows,
    }


def _real_decide() -> Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]:
    sys.path.insert(0, str(PLUGIN_ROOT))
    from layaguard import GuardEngine

    engine = GuardEngine(logger=lambda msg: print(msg, file=sys.stderr))
    engine.request_load()
    started = time.time()
    while not engine.ready():
        status = engine.status()
        if status["error"]:
            raise SystemExit(f"laya failed to load: {status['error']}")
        time.sleep(0.5)
    print(f"laya ready in {time.time() - started:.1f}s", file=sys.stderr)
    return lambda state, questions: engine.decide(state, questions, ["chat", "messages"])


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, help="write the full JSON report here")
    parser.add_argument("--limit", type=int, default=None, help="score only the first N cases")
    args = parser.parse_args(argv)
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"][: args.limit]
    questions = json.loads(QUESTIONS.read_text(encoding="utf-8"))
    report = score_cases(cases, questions, _real_decide())
    summary = {k: v for k, v in report.items() if k != "rows"}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.out:
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
