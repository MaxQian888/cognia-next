"""Tests for cognia.appearance manifest mirrors."""

from __future__ import annotations

import pytest

from cognia import (
    define_font_contribution,
    define_theme,
    define_theme_pack,
    define_wallpaper,
)


# -- theme ------------------------------------------------------------------


def test_theme_colors_variant():
    t = define_theme("night", "Night", is_dark=True, colors={"background": "#000"})
    assert t.to_dict() == {
        "id": "night",
        "name": "Night",
        "isDark": True,
        "colors": {"background": "#000"},
    }


def test_theme_vscode_variant_omits_is_dark():
    t = define_theme("imported", "Imported", vscode_json_path="themes/x.json", is_dark=True)
    # The vscode variant carries no isDark field.
    assert t.to_dict() == {
        "id": "imported",
        "name": "Imported",
        "vscodeJsonPath": "themes/x.json",
    }


def test_theme_css_variables_variant():
    t = define_theme("accent", "Accent", css_variables={"--primary": "oklch(0.7 0.1 250)"})
    d = t.to_dict()
    assert d["cssVariables"] == {"--primary": "oklch(0.7 0.1 250)"}
    assert "colors" not in d


def test_theme_requires_exactly_one_payload():
    with pytest.raises(ValueError, match="exactly one"):
        define_theme("i", "n")
    with pytest.raises(ValueError, match="exactly one"):
        define_theme("i", "n", colors={"a": "b"}, css_variables={"--x": "1"})


# -- theme-pack -------------------------------------------------------------


def test_theme_pack_minimal_and_full():
    p = define_theme_pack("pack", "Pack", {"themeId": "night", "fontFamily": "Inter"})
    assert p.to_dict() == {
        "id": "pack",
        "name": "Pack",
        "applies": {"themeId": "night", "fontFamily": "Inter"},
    }
    full = define_theme_pack(
        "pack",
        "Pack",
        {"themeId": "night"},
        description="A pack",
        preview={"light": "l.png", "dark": "d.png"},
    )
    fd = full.to_dict()
    assert fd["description"] == "A pack"
    assert fd["preview"] == {"light": "l.png", "dark": "d.png"}


def test_theme_pack_requires_name():
    with pytest.raises(ValueError):
        define_theme_pack("p", "", {"themeId": "x"})


# -- font-contribution ------------------------------------------------------


def test_font_minimal_and_full():
    f = define_font_contribution("Inter", [{"src": "inter.woff2", "weight": "400"}])
    assert f.to_dict() == {
        "family": "Inter",
        "files": [{"src": "inter.woff2", "weight": "400"}],
    }
    full = define_font_contribution(
        "Inter",
        [{"src": "inter.woff2"}],
        display="swap",
        unicode_range="U+0000-00FF",
    )
    fd = full.to_dict()
    assert fd["display"] == "swap" and fd["unicodeRange"] == "U+0000-00FF"


def test_font_validations():
    with pytest.raises(ValueError, match="at least one file"):
        define_font_contribution("Inter", [])
    with pytest.raises(ValueError, match="display"):
        define_font_contribution("Inter", [{"src": "x"}], display="fade")


# -- wallpaper --------------------------------------------------------------


def test_wallpaper_variants():
    img = define_wallpaper(
        "wp", "Mountains", {"kind": "image", "relPath": "assets/wp.jpg", "mime": "image/jpeg", "width": 1920, "height": 1080}
    )
    assert img.to_dict()["source"]["kind"] == "image"
    grad = define_wallpaper("g", "Grad", {"kind": "gradient", "css": "linear-gradient(...)"})
    assert grad.to_dict()["source"]["css"] == "linear-gradient(...)"


def test_wallpaper_rejects_bad_source():
    with pytest.raises(ValueError, match="kind"):
        define_wallpaper("wp", "W", {})
    with pytest.raises(ValueError, match="kind"):
        define_wallpaper("wp", "W", {"kind": "hologram"})
