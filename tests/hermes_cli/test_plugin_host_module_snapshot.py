"""Regression: plugin-host module eviction must tolerate concurrent imports."""
from __future__ import annotations

import sys
import threading
import types

import pytest

from hermes_cli import plugin_host_child


def test_unload_tolerates_concurrent_module_imports(monkeypatch) -> None:
    modules = {
        f"unrelated_{i}": types.ModuleType(f"unrelated_{i}") for i in range(5000)
    }
    modules["hermes_plugins.sample"] = types.ModuleType("hermes_plugins.sample")
    modules["hermes_plugins.sample.sub"] = types.ModuleType("hermes_plugins.sample.sub")
    monkeypatch.setattr(plugin_host_child, "sys", types.SimpleNamespace(modules=modules))

    runtime = plugin_host_child.HostRuntime.__new__(plugin_host_child.HostRuntime)
    runtime.refs = {}
    runtime.owners = {}
    runtime._lock = threading.Lock()
    runtime.unload_callbacks = {}
    runtime.modules = {"sample": "hermes_plugins.sample"}
    runtime.loads = {"sample": 1}

    previous_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    stop = threading.Event()
    churn_rounds = 0

    def churn() -> None:
        nonlocal churn_rounds
        while not stop.is_set():
            batch = [f"late_import_{churn_rounds}_{i}" for i in range(50)]
            for name in batch:
                modules[name] = None
            for name in batch:
                modules.pop(name, None)
            churn_rounds += 1

    churner = threading.Thread(target=churn, daemon=True)
    churner.start()
    try:
        result = runtime.op_unload({"plugin_key": "sample"})
    finally:
        stop.set()
        churner.join(timeout=10)
        sys.setswitchinterval(previous_interval)

    assert churn_rounds > 0, "churn thread never opened the race window"
    assert result == {"errors": []}
    assert "hermes_plugins.sample" not in modules
    assert "hermes_plugins.sample.sub" not in modules
    assert "unrelated_0" in modules


def test_failed_import_cleanup_tolerates_concurrent_module_imports(
    tmp_path, monkeypatch
) -> None:
    (tmp_path / "__init__.py").write_text(
        'raise RuntimeError("plugin boom")\n', encoding="utf-8"
    )
    modules = {
        f"unrelated_{i}": types.ModuleType(f"unrelated_{i}") for i in range(5000)
    }
    monkeypatch.setattr(plugin_host_child, "sys", types.SimpleNamespace(modules=modules))

    previous_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    stop = threading.Event()
    churn_rounds = 0

    def churn() -> None:
        nonlocal churn_rounds
        while not stop.is_set():
            batch = [f"late_import_{churn_rounds}_{i}" for i in range(50)]
            for name in batch:
                modules[name] = None
            for name in batch:
                modules.pop(name, None)
            churn_rounds += 1

    churner = threading.Thread(target=churn, daemon=True)
    churner.start()
    try:
        with pytest.raises(RuntimeError, match="plugin boom"):
            plugin_host_child._import_plugin(
                {"path": str(tmp_path), "module_name": "hermes_plugins.bad"}
            )
    finally:
        stop.set()
        churner.join(timeout=10)
        sys.setswitchinterval(previous_interval)

    assert churn_rounds > 0, "churn thread never opened the race window"
    assert "hermes_plugins.bad" not in modules
