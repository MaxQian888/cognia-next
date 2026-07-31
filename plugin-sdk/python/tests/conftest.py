"""Shared pytest fixtures for the Cognia Python SDK tests."""

from __future__ import annotations

import pytest

import cognia


@pytest.fixture(autouse=True)
def fresh_runtime():
    """Reset the active runtime before every test for full isolation."""
    runtime = cognia.reset_active_runtime()
    yield runtime
    cognia.reset_active_runtime()
