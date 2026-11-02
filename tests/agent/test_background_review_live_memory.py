"""The review fork must see the LIVE memory store, not the session-start snapshot.

The fork inherits the parent's cached system prompt, whose memory block is frozen when the session
starts (prefix-cache stable). In a long session every entry written after that is invisible to the
reviewer, so it re-adds paraphrases of facts that are already stored (seen on a real install: three
wordings of one fact in MEMORY.md). The memory tool cannot read the store and ``add`` only rejects
exact duplicates, and an unattended review can't patch or remove, so the copies only accumulate.
"""

from types import SimpleNamespace
from unittest.mock import patch

import agent.background_review as bg


def _run_fork_capturing_user_message(store):
    seen = {}

    def fake_build(agent, task_cfg=None, *, max_iterations, write_origin="background_review"):
        def run_conversation(**kw):
            seen["user_message"] = kw["user_message"]
        fork = SimpleNamespace(_memory_enabled=True, _user_profile_enabled=True, _memory_store=store,
                               _memory_write_origin=write_origin, run_conversation=run_conversation,
                               _session_messages=[])
        return fork, {}, False

    noop = lambda *a, **k: None
    with patch.object(bg, "build_cache_parity_fork", fake_build), \
            patch.object(bg, "_track_review_fork", noop), \
            patch.object(bg, "_snapshot_review_usage", lambda a: {}), \
            patch.object(bg, "_record_review_usage_to_parent", noop), \
            patch.object(bg, "finish_background_review_run", noop), \
            patch.object(bg, "_release_fork_clients", noop):
        bg._run_review_fork(SimpleNamespace(), [], "review memory", None, None, bg._ReviewForkState(), True)
    return seen["user_message"]


def test_review_prompt_carries_entries_written_after_session_start(tmp_path, monkeypatch):
    from tools.memory_tool_store import MemoryStore

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setattr("tools.memory_tool.get_memory_dir", lambda: tmp_path)
    store = MemoryStore(memory_char_limit=2000, user_char_limit=1000)
    store.load_from_disk()  # session start: empty snapshot frozen into the system prompt
    assert store.add("memory", "The workstation runs Manjaro on the unstable branch.")["success"]
    assert store.add("user", "The operator wants short reports.")["success"]

    message = _run_fork_capturing_user_message(store)

    assert "The workstation runs Manjaro on the unstable branch." in message
    assert "The operator wants short reports." in message


def test_review_prompt_unchanged_without_a_memory_store():
    message = _run_fork_capturing_user_message(None)
    assert message.startswith("review memory")
    assert "§" not in message
