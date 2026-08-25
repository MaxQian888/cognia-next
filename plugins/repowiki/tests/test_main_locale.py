"""The wiki's language, and the panel's chrome, follow the app.

Decision 26 of the design pass: the wiki is written in the app's language
unless the user picks one. Both halves of that are easy to ship broken in a way
nothing notices — a hardcoded ``"en"`` default reads as "working" to an English
reviewer, and an untranslated panel label reads as "working" until someone
switches the app to Chinese.
"""

from __future__ import annotations

import pytest

import main
from repowiki.panel import DEFAULT_LABELS


class FakeI18n:
    """Stands in for ``ctx.i18n``. Only the two data methods are used."""

    def __init__(self, locale="en", table=None, raises=None):
        self._locale = locale
        self._table = table or {}
        self._raises = raises
        self.asked: list[str] = []

    async def getCurrentLocale(self):  # noqa: N802 — mirrors the host method
        if self._raises:
            raise self._raises
        return self._locale

    async def t(self, key):
        self.asked.append(key)
        # The host echoes the key back when nothing resolved it.
        return self._table.get(key, key)


class FakeCtx:
    def __init__(self, i18n):
        self.i18n = i18n


class FakeCognia:
    def __init__(self, i18n):
        self.ctx = FakeCtx(i18n)


@pytest.fixture(autouse=True)
def reset_module_state(monkeypatch):
    monkeypatch.setattr(main, "_LOCALE", "", raising=False)
    monkeypatch.setattr(main, "_LABELS", dict(DEFAULT_LABELS), raising=False)
    yield


def _install(i18n, monkeypatch):
    monkeypatch.setattr(main, "cognia", FakeCognia(i18n))
    return i18n


async def test_the_wiki_follows_the_app_language_when_the_user_picked_none(monkeypatch):
    _install(FakeI18n(locale="zh-CN"), monkeypatch)
    monkeypatch.setattr(main, "get_config", lambda: {})

    await main._resolve_locale_and_labels()
    assert main._config().language == "zh"


async def test_an_explicit_setting_beats_the_app_language(monkeypatch):
    _install(FakeI18n(locale="zh-CN"), monkeypatch)
    monkeypatch.setattr(main, "get_config", lambda: {"language": "ja"})

    await main._resolve_locale_and_labels()
    assert main._config().language == "ja"


async def test_an_unmapped_locale_falls_back_to_english_rather_than_a_locale_code(monkeypatch):
    # `_lang_instruction` looks the value up in a table; a miss silently means
    # English, so passing "de-DE" through would look like it worked.
    _install(FakeI18n(locale="de-DE"), monkeypatch)
    monkeypatch.setattr(main, "get_config", lambda: {})

    await main._resolve_locale_and_labels()
    assert main._config().language == "en"


async def test_panel_labels_come_back_translated(monkeypatch):
    i18n = _install(FakeI18n(locale="zh-CN", table={"panel.rescan": "重新扫描"}), monkeypatch)
    await main._resolve_locale_and_labels()

    assert main._LABELS["panel.rescan"] == "重新扫描"
    # Every label is asked for, not just the ones that happen to be used today.
    assert set(i18n.asked) == set(DEFAULT_LABELS)


async def test_an_unresolved_key_stays_english_instead_of_painting_the_key(monkeypatch):
    # `t` echoes the key back on a miss. Painting "panel.rescan" into a button
    # is the failure this guards.
    _install(FakeI18n(locale="zh-CN", table={}), monkeypatch)
    await main._resolve_locale_and_labels()

    assert main._LABELS["panel.rescan"] == DEFAULT_LABELS["panel.rescan"]


async def test_a_host_with_no_i18n_leaves_an_english_panel_rather_than_failing(monkeypatch):
    # Headless, or an older host. The panel it had before this existed.
    _install(FakeI18n(raises=RuntimeError("no such namespace")), monkeypatch)
    monkeypatch.setattr(main, "get_config", lambda: {})

    await main._resolve_locale_and_labels()
    assert main._LABELS == DEFAULT_LABELS
    assert main._config().language == "en"


async def test_the_panel_re_asks_the_locale_because_it_cannot_subscribe(monkeypatch):
    # `i18n.onLocaleChange` hands the host a callback, which is the one thing
    # that cannot cross the stdio boundary (ADR-0145). Re-asking when the panel
    # opens is the poll that stands in for the subscription — without it, a
    # user who switches the app to Chinese keeps an English panel until the
    # plugin is reloaded.
    i18n = _install(FakeI18n(locale="en", table={}), monkeypatch)
    monkeypatch.setattr(main, "get_config", lambda: {})
    monkeypatch.setattr(main, "_SCANS", {}, raising=False)

    async def _noop(_surface_id, *, create=False):
        return {}

    monkeypatch.setattr(main, "_push_panel", _noop)

    await main.repowiki_build_panel("cognia-repowiki:session:s1")
    first = len(i18n.asked)
    assert first == len(DEFAULT_LABELS)

    i18n._locale = "zh-CN"
    i18n._table = {"panel.rescan": "重新扫描"}
    await main.repowiki_build_panel("cognia-repowiki:session:s1")

    assert main._LABELS["panel.rescan"] == "重新扫描"
    assert len(i18n.asked) == first * 2
