"""Metrics of the opt-in laya calibration script, driven by a fake engine."""

from __future__ import annotations

import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

import calibrate_jev as cal  # noqa: E402


def _answers(case, *, wrong=False, danger_offset=0.0):
    e = case["expect"]
    flip = (lambda b: not b) if wrong else (lambda b: b)
    return {
        "ok": True,
        "answers": {
            **{k: {"type": "noul", "noul": 0.9 if flip(bool(e[k])) else 0.1} for k in cal.NOUL_KEYS},
            **{k: {"type": "choice", "choice": "zzz" if wrong else e[k]} for k in cal.CHOICE_KEYS},
            cal.SCORE_KEY: {"type": "score", "score": e[cal.SCORE_KEY] + danger_offset},
        },
    }


def _cases():
    return json.loads(cal.FIXTURE.read_text(encoding="utf-8"))["cases"]


def test_fixture_and_questions_are_complete():
    cases = _cases()
    questions = json.loads(cal.QUESTIONS.read_text(encoding="utf-8"))
    assert len(cases) == 30
    assert set(questions) == set(cal.NOUL_KEYS + cal.CHOICE_KEYS + (cal.SCORE_KEY,))
    for case in cases:
        assert {m["from"] for m in case["messages"]} <= {"me", "other"}
        assert set(case["expect"]) == set(questions)


def test_perfect_engine_passes_the_bar():
    by_id = {c["id"]: c for c in _cases()}
    report = cal.score_cases(
        list(by_id.values()),
        {},
        lambda state, q: _answers(next(c for c in by_id.values() if cal.build_state(c) == state)),
    )
    assert report["passed"] is True
    assert report["dangerMae"] == 0.0
    assert all(rate == 1.0 for rate in report["hitRates"].values())


def test_wrong_engine_fails_the_bar_and_reports_failures():
    cases = _cases()[:4]
    calls = iter(range(len(cases)))

    def decide(state, q):
        i = next(calls)
        if i == 0:
            return {"ok": False, "error": {"kind": "not_ready"}}
        return _answers(cases[i], wrong=True, danger_offset=2.0)

    report = cal.score_cases(cases, {}, decide)
    assert report["answered"] == 3
    assert report["failures"][0]["id"] == cases[0]["id"]
    assert report["dangerMae"] == 2.0
    assert report["passes"] == {"danger_level": False, "true_intent": False, "she_needs": False}
    assert report["passed"] is False


def test_build_state_uses_the_calibrated_shape():
    state = cal.build_state({"relationship": "", "messages": [{"from": "other", "text": "hi"}]})
    assert state == {
        "chat": {"relationship": "unspecified", "messages": [{"from": "other", "text": "hi"}], "latest_from": "other"}
    }
