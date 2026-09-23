"""Packaging and licence checks (P9 licence audit L7/L8): what ships, and under what terms."""

import hashlib
import re
import tomllib
from pathlib import Path

import pytest

from polyflow_temporal import quickjs_engines as qe

HERE = Path(__file__).resolve().parents[1]
PYPROJECT = tomllib.loads((HERE / "pyproject.toml").read_text(encoding="utf-8"))
VENDOR = HERE / "polyflow_temporal" / "vendor" / "quickjs-wasi"


def test_the_quickjs_wasm_in_use_is_the_one_its_provenance_names():
    # The wasm is not shipped: it is resolved (env, user cache, dev-tree vendor) or
    # fetched from npm on first use. Whatever the resolver returns must be the build
    # PROVENANCE.txt records, and the resolver's pins must be the recorded ones.
    provenance = (VENDOR / "PROVENANCE.txt").read_text(encoding="utf-8")
    m = re.search(r"sha256\(package/quickjs\.wasm\)\s*=\s*([0-9a-f]{64})", provenance)
    t = re.search(r"sha256\(quickjs-wasi-([0-9.]+)\.tgz\)\s*=\s*([0-9a-f]{64})", provenance)
    assert m and t, "PROVENANCE.txt records the tarball's and the wasm's sha256"
    assert qe.QUICKJS_WASM_SHA256 == m.group(1)
    assert (qe.QUICKJS_WASI_VERSION, qe.QUICKJS_WASI_TARBALL_SHA256) == (t.group(1), t.group(2))
    assert qe.QUICKJS_WASI_TARBALL_URL.endswith(f"quickjs-wasi-{t.group(1)}.tgz")
    path = qe.resolve_quickjs_wasm()
    assert hashlib.sha256(path.read_bytes()).hexdigest() == m.group(1)
    assert (VENDOR / "LICENSE").read_text(encoding="utf-8").startswith("MIT License")


def test_the_wheel_ships_the_quickjs_licence_but_not_the_wasm():
    data = PYPROJECT["tool"]["setuptools"]["package-data"]["polyflow_temporal"]
    assert "vendor/quickjs-wasi/LICENSE" in data and "vendor/quickjs-wasi/PROVENANCE.txt" in data
    assert not any(p.endswith(("*", ".wasm")) and "quickjs-wasi" in p for p in data)


def _no_wasm_anywhere(monkeypatch, tmp_path):
    monkeypatch.delenv(qe.ENV_WASM_PATH, raising=False)
    monkeypatch.setattr(qe, "cache_dir", lambda: tmp_path / "cache")
    monkeypatch.setattr(qe, "VENDORED_WASM", tmp_path / "vendor" / "quickjs.wasm")

    def no_network(url):
        raise AssertionError(f"network used: {url}")
    monkeypatch.setattr(qe, "_download", no_network)


def test_a_tampered_quickjs_wasm_is_refused(monkeypatch, tmp_path):
    good = qe.read_verified_wasm(qe.resolve_quickjs_wasm())
    tampered = tmp_path / "quickjs.wasm"
    tampered.write_bytes(good[:-1] + bytes([good[-1] ^ 1]))
    _no_wasm_anywhere(monkeypatch, tmp_path)
    with pytest.raises(qe.QuickJSWasmMismatch, match="refusing"):
        qe.read_verified_wasm(tampered)
    with pytest.raises(qe.QuickJSWasmMismatch):  # an explicit path is verified too
        qe._load_wasm(tampered)
    monkeypatch.setenv(qe.ENV_WASM_PATH, str(tampered))
    with pytest.raises(qe.QuickJSWasmMismatch):  # refused, not skipped over for a fetch
        qe.resolve_quickjs_wasm()
    monkeypatch.delenv(qe.ENV_WASM_PATH)
    cached = qe.cached_wasm_path()
    cached.parent.mkdir(parents=True)
    cached.write_bytes(tampered.read_bytes())
    with pytest.raises(qe.QuickJSWasmMismatch):  # a tampered cache as well
        qe._load_wasm(qe.VENDORED_WASM)


def test_a_tarball_that_is_not_the_pinned_one_is_refused_and_nothing_is_cached(monkeypatch, tmp_path):
    _no_wasm_anywhere(monkeypatch, tmp_path)
    monkeypatch.setattr(qe, "_download", lambda url: b"not the pinned tarball")
    with pytest.raises(qe.QuickJSWasmMismatch, match="refusing"):
        qe.fetch_quickjs_wasm()
    assert not qe.cached_wasm_path().exists()


def test_no_fetch_names_the_command_and_the_env_var(monkeypatch, tmp_path):
    _no_wasm_anywhere(monkeypatch, tmp_path)
    monkeypatch.setenv(qe.ENV_NO_FETCH, "1")
    with pytest.raises(qe.QuickJSWasmUnavailable) as err:
        qe.resolve_quickjs_wasm()
    assert "python -m polyflow_temporal.quickjs_engines fetch" in str(err.value)
    assert "POLYFLOW_QUICKJS_NO_FETCH" in str(err.value)
    with pytest.raises(qe.QuickJSWasmUnavailable):  # the engine's default path goes the same way
        qe._load_wasm(qe.VENDORED_WASM)
    monkeypatch.setenv(qe.ENV_WASM_PATH, str(tmp_path / "missing.wasm"))
    with pytest.raises(qe.QuickJSWasmUnavailable, match="does not exist"):
        qe.resolve_quickjs_wasm()


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
