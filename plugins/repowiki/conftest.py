"""Make the plugin's entry module importable by the test suite.

`main.py` sits at the plugin root rather than inside the `repowiki` package —
that is where the host looks for `pythonMain` — so pytest, which only puts the
test directory on the path, cannot see it. The SDK is added too because `main`
imports `cognia` at module scope; importing it is fine offline, and only a call
that actually reaches the host fails.

Without this, `main.py` is the one file in the plugin with no test at all, and
it is the file that wires everything else together.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent
_SDK_SRC = _PLUGIN_ROOT.parents[1] / "plugin-sdk" / "python" / "src"

for path in (_PLUGIN_ROOT, _SDK_SRC):
    if path.is_dir() and str(path) not in sys.path:
        sys.path.insert(0, str(path))
