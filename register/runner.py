from __future__ import annotations

from pathlib import Path
import runpy


if __name__ == "__main__":
    legacy_entrypoint = Path(__file__).with_name("DrissionPage_example.py")
    runpy.run_path(str(legacy_entrypoint), run_name="__main__")
