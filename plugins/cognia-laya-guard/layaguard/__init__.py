"""Laya Guard — local System-1 decision engine wrapper for the plugin.

`engine` is deliberately free of any ``cognia`` import so the whole decision
surface is unit-testable without a running host. ``main.py`` owns the wiring.
"""

from .engine import GuardEngine

__all__ = ["GuardEngine"]
