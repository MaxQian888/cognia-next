"""Config: what the host owns, and what the plugin still decides.

Upstream's version tested a model-alias table, `~/.repowiki/config.json`, and a
fallback chain through `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY`. All three are gone on purpose, and the tests are rewritten
around the reason rather than deleted: model routing and provider credentials
belong to the host, and a plugin that could read a provider key is a plugin
that could exfiltrate one.
"""

from __future__ import annotations

from repowiki.config import Config, resolve_model


def test_model_ids_pass_through_untouched():
    # No alias table: whatever the user configured is what the host is asked
    # for, so a model this plugin has never heard of still works.
    assert resolve_model("anthropic/claude-something-new") == "anthropic/claude-something-new"
    assert resolve_model("  gpt-5-mini  ") == "gpt-5-mini"
    assert resolve_model("") == ""


def test_from_host_reads_the_plugins_own_settings():
    cfg = Config.from_host(
        {"language": "zh", "concurrency": 3, "max_context_tokens": 8000, "rag_top_k": 9}
    )
    assert cfg.language == "zh"
    assert cfg.concurrency == 3
    assert cfg.max_context_tokens == 8000
    assert cfg.rag_top_k == 9


def test_from_host_ignores_settings_it_does_not_understand():
    # The host may ship a setting ahead of a plugin that reads it; an older
    # plugin has to keep loading rather than refuse the whole config.
    cfg = Config.from_host({"language": "ja", "someFutureKnob": True})
    assert cfg.language == "ja"
    assert not hasattr(cfg, "someFutureKnob")


def test_credentials_never_survive_into_the_plugin():
    # Even if a key somehow lands in the settings blob, it is dropped: every
    # model call goes through ctx.agent, which never needs one.
    cfg = Config.from_host({"api_key": "sk-leaked", "api_base": "https://evil.example"})
    assert cfg.api_key == ""
    assert cfg.api_base == ""


def test_from_host_clamps_nonsense_into_something_runnable():
    cfg = Config.from_host({"concurrency": 0, "max_context_tokens": -1})
    assert cfg.concurrency == 1
    assert cfg.max_context_tokens == 0


def test_from_host_defaults_when_the_host_says_nothing():
    cfg = Config.from_host(None)
    assert cfg.model == ""
    assert cfg.concurrency == 5
    # Not "en": the wiki follows the app's language unless the user picked one,
    # and `main._config` is what turns "auto" into a real language. Hardcoding
    # "en" here is how a Chinese user gets an English wiki by default.
    assert cfg.language == "auto"


def test_an_explicit_language_beats_the_app(monkeypatch):
    # The setting exists precisely so someone reading in Chinese can generate
    # an English wiki for an English-speaking team.
    assert Config.from_host({"language": "ja"}).language == "ja"


def test_offline_load_still_honours_the_tuning_env_knobs(monkeypatch):
    # `load()` is the no-host entry point the vendored suites use; the RAG
    # tuning knobs stay reachable there so those tests keep their coverage.
    monkeypatch.setenv("REPOWIKI_CONCURRENCY", "3")
    monkeypatch.setenv("REPOWIKI_MAX_CONTEXT_TOKENS", "8000")
    cfg = Config.load()
    assert cfg.concurrency == 3
    assert cfg.max_context_tokens == 8000


def test_offline_load_ignores_an_unparsable_knob(monkeypatch):
    monkeypatch.setenv("REPOWIKI_CONCURRENCY", "not-a-number")
    assert Config.load().concurrency == 5  # default


def test_offline_load_reads_no_credentials(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "ds-fallback")
    monkeypatch.setenv("REPOWIKI_API_KEY", "test-key-123")
    cfg = Config.load()
    assert cfg.api_key == ""
