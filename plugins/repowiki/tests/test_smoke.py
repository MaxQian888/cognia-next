"""Smoke tests — import every ported module so a regression fails on ImportError.

Upstream imported ``repowiki.cli`` here. The Click CLI and the FastAPI server
are deliberately not vendored (the host is the interface), so this asserts the
opposite as well: those modules must stay absent, or a later edit could quietly
drag Click and FastAPI back into the plugin's dependency set.
"""

import importlib

import pytest

PORTED = [
    "repowiki",
    "repowiki.config",
    "repowiki.host",
    "repowiki.project",
    "repowiki.core.analyzer",
    "repowiki.core.cache",
    "repowiki.core.graph",
    "repowiki.core.mermaid",
    "repowiki.core.models",
    "repowiki.core.rag",
    "repowiki.core.rag_store",
    "repowiki.core.scanner",
    "repowiki.core.wiki_builder",
    "repowiki.export.html",
    "repowiki.export.json_export",
    "repowiki.export.markdown",
    "repowiki.ingest.git_diff",
    "repowiki.ingest.github",
    "repowiki.ingest.local",
    "repowiki.llm.client",
    "repowiki.llm.prompts",
]

DROPPED = ["repowiki.cli", "repowiki.server", "repowiki.export.site"]


@pytest.mark.parametrize("name", PORTED)
def test_ported_module_imports(name):
    assert importlib.import_module(name) is not None


@pytest.mark.parametrize("name", DROPPED)
def test_dropped_module_stays_dropped(name):
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module(name)


def test_version_string():
    m = importlib.import_module("repowiki")
    v = getattr(m, "__version__", None)
    assert v is None or isinstance(v, str)
