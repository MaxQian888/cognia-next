"""The plugin's user-facing strings: translated through ``ctx.i18n``, English otherwise.

Two strings reach a person — the hover note on an observe-mode inbound label
and the decision provider's status line in Settings. Both are resolved against
this plugin's own ``plugin.json`` bundle through ``ctx.i18n.t``, driven here
through the SDK runtime's offline host-call seam, the same shape the embedded
host answers.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from cognia.runtime import get_active_runtime

import main

MANIFEST = json.loads((Path(__file__).resolve().parents[1] / "plugin.json").read_text("utf8"))
LOCALES = MANIFEST["i18n"]["locales"]


class StatusEngine:
    def __init__(self, status):
        self._status = status
        self.config = {"checkpoint": "auto", "inboundThreshold": 0.75}

    def status(self):
        return dict(self._status)


class FakeI18nHost:
    """Answers ``i18n.*`` the way the host does: locale → en → the key itself."""

    def __init__(self, locale="zh-CN"):
        self.locale = locale
        self.calls = []

    def __call__(self, method, params):
        self.calls.append(method)
        if method == "i18n.getCurrentLocale":
            return self.locale
        if method == "i18n.t":
            key = params["args"][0]
            bundle = LOCALES.get(self.locale, {})
            return bundle.get(key, LOCALES["en"].get(key, key))
        raise AssertionError(f"unexpected host call {method}")


@pytest.fixture(autouse=True)
def reset_text():
    runtime = get_active_runtime()
    yield
    runtime.set_host_call_handler(None)
    main._TEXT.clear()
    main._TEXT.update(main.TEXT_DEFAULTS)
    main._TEXT_STATE.update({"locale": None, "checkedAt": None})


def _attach(host):
    get_active_runtime().set_host_call_handler(host)
    return host


def test_every_runtime_string_ships_in_both_locales():
    for locale in ("en", "zh-CN"):
        missing = [key for key in main.TEXT_DEFAULTS if key not in LOCALES[locale]]
        assert missing == [], f"{locale} is missing {missing}"


def test_the_english_bundle_matches_the_in_code_defaults():
    # The defaults are what a host with no i18n namespace paints; drifting from
    # the bundle would make the same install read differently offline.
    for key, default in main.TEXT_DEFAULTS.items():
        assert LOCALES["en"][key] == default


def test_the_placeholders_survive_translation():
    for key, default in main.TEXT_DEFAULTS.items():
        expected = sorted(main._PLACEHOLDER.findall(default))
        assert sorted(main._PLACEHOLDER.findall(LOCALES["zh-CN"][key])) == expected, key


def test_without_a_host_the_strings_stay_english():
    main.refresh_text()
    verdict = {"triggered": ["spam"], "scores": {"spam": 0.9}, "truncated": True}
    labels = main.observe_labels(verdict, {"inboundThreshold": 0.75})
    assert labels[0]["note"] == (
        "laya observe mode · threshold 0.75 · message truncated to the head window"
    )


def test_the_observe_note_follows_the_app_language():
    _attach(FakeI18nHost("zh-CN"))
    main.refresh_text()
    verdict = {"triggered": ["spam"], "scores": {"spam": 0.9}, "truncated": True}
    labels = main.observe_labels(verdict, {"inboundThreshold": 0.8})
    assert labels[0]["note"] == "laya 观察模式 · 阈值 0.8 · 消息过长，仅检测了开头部分"
    # The chip text itself stays the host-translated key's literal fallback.
    assert labels[0]["label"] == "Spam"


def test_the_inbound_path_polls_the_language_at_most_once_a_minute(monkeypatch):
    host = _attach(FakeI18nHost("zh-CN"))
    verdict = {"triggered": ["spam"], "scores": {"spam": 0.9}, "truncated": False}
    main.observe_labels(verdict, {"inboundThreshold": 0.75})
    first = len(host.calls)
    assert first > 0
    main.observe_labels(verdict, {"inboundThreshold": 0.75})
    assert len(host.calls) == first  # cached: no round trip per message

    host.locale = "en"
    later = main._clock() + main.TEXT_REFRESH_SECONDS + 1
    monkeypatch.setattr(main, "_clock", lambda: later)
    labels = main.observe_labels(verdict, {"inboundThreshold": 0.75})
    assert labels[0]["note"] == "laya observe mode · threshold 0.75"


def test_a_key_the_host_cannot_resolve_keeps_its_english_default():
    class PartialHost(FakeI18nHost):
        def __call__(self, method, params):
            if method == "i18n.t" and params["args"][0] == "status.loading":
                return "status.loading"  # `t` echoes an unresolved key
            return super().__call__(method, params)

    _attach(PartialHost("zh-CN"))
    main.refresh_text()
    assert main.text("status.loading") == "laya checkpoint is loading"
    assert main.text("status.notLoaded") == "laya 模型尚未加载"


def _dispatch_status():
    return get_active_runtime().dispatch_contribution("laya-local", "status", [])


def test_provider_status_is_translated(monkeypatch):
    _attach(FakeI18nHost("zh-CN"))
    monkeypatch.setattr(
        main,
        "ENGINE",
        StatusEngine({"ready": False, "loading": True, "error": None, "retryInSeconds": None}),
    )
    assert _dispatch_status() == {"ready": False, "loading": True, "message": "laya 模型正在加载"}

    monkeypatch.setattr(
        main,
        "ENGINE",
        StatusEngine({"ready": False, "loading": False, "error": None, "retryInSeconds": 42.4}),
    )
    assert _dispatch_status() == {"ready": False, "message": "laya 模型尚未加载（42 秒后重试）"}


def test_provider_status_relays_the_engine_error_verbatim(monkeypatch):
    # The diagnostic is data; only the wording around it is translated.
    _attach(FakeI18nHost("zh-CN"))
    monkeypatch.setattr(
        main,
        "ENGINE",
        StatusEngine({"ready": False, "loading": False, "error": "OSError: disk", "retryInSeconds": None}),
    )
    assert _dispatch_status() == {"ready": False, "message": "OSError: disk"}


def test_a_ready_provider_makes_no_host_call(monkeypatch):
    host = _attach(FakeI18nHost("zh-CN"))
    monkeypatch.setattr(main, "ENGINE", StatusEngine({"ready": True, "loading": False, "error": None}))
    assert _dispatch_status() == {"ready": True}
    assert host.calls == []
