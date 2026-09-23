"""Packaging and licence checks (P9 licence audit L7/L8): what ships, and under what terms."""

import hashlib
import re
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
PYPROJECT = tomllib.loads((HERE / "pyproject.toml").read_text(encoding="utf-8"))
VENDOR = HERE / "polyflow_temporal" / "vendor" / "quickjs-wasi"


def test_the_vendored_quickjs_wasm_is_the_one_its_provenance_names():
    provenance = (VENDOR / "PROVENANCE.txt").read_text(encoding="utf-8")
    m = re.search(r"sha256\(package/quickjs\.wasm\)\s*=\s*([0-9a-f]{64})", provenance)
    assert m, "PROVENANCE.txt records the wasm's sha256"
    assert hashlib.sha256((VENDOR / "quickjs.wasm").read_bytes()).hexdigest() == m.group(1)
    assert (VENDOR / "LICENSE").read_text(encoding="utf-8").startswith("MIT License")


def test_the_package_declares_its_licence_and_ships_the_text():
    project = PYPROJECT["project"]
    assert project["license"] == "Apache-2.0", "PEP 639 licence expression (L8)"
    assert project["license-files"] == ["LICENSE"]
    text = (HERE / "LICENSE").read_text(encoding="utf-8")
    assert "Apache License" in text and "Version 2.0" in text
    assert text == (HERE.parents[1] / "LICENSE").read_text(encoding="utf-8"), "a copy of the repository's LICENSE"


def test_mpl_licensed_dependencies_stay_in_the_openai_agents_extra():
    # openai-agents pulls certifi and tqdm (MPL-2.0). The core install and every other
    # extra must not depend on it (L7).
    project = PYPROJECT["project"]
    assert all("openai" not in d for d in project["dependencies"])
    for extra, deps in project["optional-dependencies"].items():
        if extra != "openai-agents":
            assert all("openai" not in d and "certifi" not in d and "tqdm" not in d for d in deps), extra
