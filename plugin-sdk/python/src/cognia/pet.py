"""Typed manifest mirrors for the desktop-pet capability family (ADR-0058).

Python author-facing helpers mirroring the TypeScript ``define-*`` helpers:

* ``pet-item``        → ``PluginPetItemDef``        (manifest ``petItems``)
* ``pet-achievement`` → ``PluginPetAchievementDef`` (manifest ``petAchievements``)

Each helper builds a validated dataclass whose ``to_dict()`` emits the camelCase
shape the host reads from the manifest. ``labels`` / ``descriptions`` are locale
maps (``{ "en": "...", "zh-CN": "..." }``); an achievement ``condition`` is
carried as a plain dict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional

# Pet item categories (PluginPetItemDef.category).
_PET_ITEM_CATEGORIES = frozenset({"food", "toy", "decor"})
# Pet interaction kinds (PluginPetItemDef.interactionKind).
_PET_INTERACTION_KINDS = frozenset(
    {"fed", "played", "petted", "talked", "slept", "cleaned", "treated"}
)


def _require(value: str, label: str) -> None:
    if not value or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")


# -- pet-item ---------------------------------------------------------------


@dataclass(frozen=True)
class PetItem:
    """A pet shop item (mirrors ``PluginPetItemDef``)."""

    id: str
    labels: Dict[str, str]
    category: str
    price: int
    consumable: bool
    descriptions: Optional[Dict[str, str]] = None
    icon: Optional[str] = None
    interaction_kind: Optional[str] = None
    needs_effect: Optional[Dict[str, float]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "labels": dict(self.labels),
            "category": self.category,
            "price": self.price,
            "consumable": self.consumable,
        }
        if self.descriptions is not None:
            out["descriptions"] = dict(self.descriptions)
        if self.icon is not None:
            out["icon"] = self.icon
        if self.interaction_kind is not None:
            out["interactionKind"] = self.interaction_kind
        if self.needs_effect is not None:
            out["needsEffect"] = dict(self.needs_effect)
        return out


def define_pet_item(
    id: str,
    labels: Mapping[str, str],
    category: str,
    price: int,
    consumable: bool,
    *,
    descriptions: Optional[Mapping[str, str]] = None,
    icon: Optional[str] = None,
    interaction_kind: Optional[str] = None,
    needs_effect: Optional[Mapping[str, float]] = None,
) -> PetItem:
    """Construct a validated ``PetItem``. ``category`` must be
    ``food`` / ``toy`` / ``decor``; ``interaction_kind`` (if set) must be one of
    the seven known kinds."""
    _require(id, "pet item id")
    if not labels:
        raise ValueError("pet item labels must be a non-empty locale map")
    if category not in _PET_ITEM_CATEGORIES:
        raise ValueError(
            f"unknown pet item category {category!r}; expected one of "
            f"{sorted(_PET_ITEM_CATEGORIES)}"
        )
    if interaction_kind is not None and interaction_kind not in _PET_INTERACTION_KINDS:
        raise ValueError(
            f"unknown interaction_kind {interaction_kind!r}; expected one of "
            f"{sorted(_PET_INTERACTION_KINDS)}"
        )
    return PetItem(
        id=id,
        labels=dict(labels),
        category=category,
        price=price,
        consumable=consumable,
        descriptions=dict(descriptions) if descriptions is not None else None,
        icon=icon,
        interaction_kind=interaction_kind,
        needs_effect=dict(needs_effect) if needs_effect is not None else None,
    )


# -- pet-achievement --------------------------------------------------------


@dataclass(frozen=True)
class PetAchievement:
    """A pet achievement (mirrors ``PluginPetAchievementDef``)."""

    id: str
    labels: Dict[str, str]
    condition: Dict[str, Any]
    descriptions: Optional[Dict[str, str]] = None
    icon: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "labels": dict(self.labels),
            "condition": dict(self.condition),
        }
        if self.descriptions is not None:
            out["descriptions"] = dict(self.descriptions)
        if self.icon is not None:
            out["icon"] = self.icon
        return out


def define_pet_achievement(
    id: str,
    labels: Mapping[str, str],
    condition: Mapping[str, Any],
    *,
    descriptions: Optional[Mapping[str, str]] = None,
    icon: Optional[str] = None,
) -> PetAchievement:
    """Construct a validated ``PetAchievement``. ``labels`` and ``condition``
    are required."""
    _require(id, "pet achievement id")
    if not labels:
        raise ValueError("pet achievement labels must be a non-empty locale map")
    if not condition:
        raise ValueError("pet achievement condition must be a non-empty mapping")
    return PetAchievement(
        id=id,
        labels=dict(labels),
        condition=dict(condition),
        descriptions=dict(descriptions) if descriptions is not None else None,
        icon=icon,
    )
