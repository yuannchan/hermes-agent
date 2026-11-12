<p align="center">
  <img src="assets/banner.png" alt="Holo" width="100%">
</p>

# Holo

> **Holo** is a personal, Windows-first fork of [Hermes Agent](https://github.com/NousResearch/hermes-agent) by [Nous Research](https://nousresearch.com). The agent core is untouched — the `hermes` command, gateway, tool system, skills, and memory all behave as upstream — while the desktop shell carries a distinct identity and a small set of local fixes. Every local change lives in its own reviewable commit, so upstream updates continue to merge cleanly.

<p align="center">
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/Upstream-NousResearch%2Fhermes--agent-8A2BE2?style=for-the-badge" alt="Upstream: NousResearch/hermes-agent"></a>
  <a href="https://hermes-agent.nousresearch.com/docs/"><img src="https://img.shields.io/badge/Docs-hermes--agent.nousresearch.com-FFD700?style=for-the-badge" alt="Documentation"></a>
  <a href="https://github.com/NousResearch/hermes-agent/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://discord.gg/NousResearch"><img src="https://img.shields.io/badge/Discord-upstream%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord (upstream community)"></a>
</p>

## Why this fork exists

This is the working copy behind the author's daily desktop setup. It exists to:

- **Keep a distinct desktop identity** — app name, icon, wordmark, and theme are "Holo", so a patched build is never confused with the installed official app. Branding strings are renamed in place; no behavior is attached to the name.
- **Land local fixes in reviewable units** — each fix is one commit with its own verification, kept on top of a clean mirror of upstream.
- **Stay mergeable** — `main` mirrors upstream `main` untouched; all local work sits on `local-fixes`.

## What this fork changes

### Desktop shell

| Area | Change |
|---|---|
| Identity | App name/wordmark "Holo", custom app icons, window and sign-in titles |
| Intro screen | App emblem + wordmark + neutral subtitle; stock intro copy matches upstream (brand word only) |
| Theme | Added a light "holo" preset (accent `#a65c3b`) |
| Statusbar | 24px height keeps labels and icons fully visible at 90% UI zoom |
| Settings | About page shows version + local uninstall only — no built-in update channel; no shared metrics are collected or sent |
| Bundled plugins | Prebuilt `dist` bundles of plugin dashboards removed; dashboards are built on demand |

### Core fixes (each its own commit on `local-fixes`)

- `fix(plugins)` — snapshot plugin modules before concurrent eviction (race when a plugin is evicted while in use)
- `fix(memory)` — the memory-review fork reads the live store, not the session-start snapshot
- `fix(memory)` — sanitize live memory entries before review
- `fix(desktop)` — repaint confirmed on primary model switch (stale model pill)
- `fix(deps)` — pin `av 18.1.0` alongside `faster-whisper 1.2.1` (binary compatibility)

### Unchanged, inherited from upstream

Agent loop, toolset system, skills, memory, gateway platforms, model routing, CLI commands, and data layout — all as upstream. Anything not listed above is upstream code.

## Branch layout

| Branch | Contents |
|---|---|
| `main` | Clean mirror of upstream `main` — no local changes |
| `local-fixes` | `main` + the reviewed local commits; this is what runs on the author's machine |
| remotes | `upstream` → NousResearch/hermes-agent · `origin` → this fork |

## Repository map

The root looks busy because this is a full monorepo — agent, CLI, desktop app, and gateway all live in one tree. The main areas:

| Path | What lives there |
|---|---|
| `agent/`, `hermes_cli/`, `gateway/`, `platform/` | Agent loop, CLI commands, messaging gateway, platform adapters |
| `apps/desktop/` | Electron desktop app (renderer + main process) |
| `apps/shared/` | Shared TypeScript packages (incl. the compiled theme presets) |
| `plugins/` | Bundled first-party plugins |
| `skills/`, `optional-skills/` | The skill library shipped with the agent |
| `tests/`, `evals/` | Python test suite, evaluation harnesses |
| `pm/`, `scripts/`, `tools/`, `docker/` | Developer tooling: PM package manager, CI/build scripts, docker |
| `ui-tui/`, `web/`, `website/` | Terminal UI, web chat, documentation site |

Everything else at the root is build/config plumbing (`pyproject.toml`, lockfiles, `Dockerfile`, activation scripts for the PM-managed dev environment).

## Running this fork

This fork is not published as an installer. It runs from source using the upstream developer workflow — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [developer guide](https://hermes-agent.nousresearch.com/docs/developer-guide/).

For the official, supported application, install [Hermes Agent](https://hermes-agent.nousresearch.com/) from upstream instead.

---

## What Hermes Agent is (upstream)

**The self-improving AI agent built by [Nous Research](https://nousresearch.com).** It's the only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations, and builds a deepening model of who you are across sessions. Run it on a $5 VPS, a GPU cluster, or serverless infrastructure that costs nearly nothing when idle. It's not tied to your laptop — talk to it from Telegram while it works on a cloud VM.

Use any model you want — [Nous Portal](https://portal.nousresearch.com), OpenRouter, OpenAI, your own endpoint, and [many others](https://hermes-agent.nousresearch.com/docs/integrations/providers). Switch with `hermes model` — no code changes, no lock-in.

<table>
<tr><td><b>A real terminal interface</b></td><td>Full TUI with multiline editing, slash-command autocomplete, conversation history, interrupt-and-redirect, and streaming tool output.</td></tr>
<tr><td><b>Lives where you do</b></td><td>Telegram, Discord, Slack, WhatsApp, Signal, and CLI — all from a single gateway process. Voice memo transcription, cross-platform conversation continuity.</td></tr>
<tr><td><b>A closed learning loop</b></td><td>Agent-curated memory with periodic nudges. Autonomous skill creation after complex tasks. Skills self-improve during use. FTS5 session search with LLM summarization for cross-session recall. <a href="https://agentskills.io">agentskills.io</a> open-standard skills.</td></tr>
<tr><td><b>Scheduled automations</b></td><td>Built-in cron scheduler with delivery to any platform. Daily reports, nightly backups, weekly audits — all in natural language, running unattended.</td></tr>
<tr><td><b>Delegates and parallelizes</b></td><td>Spawn isolated subagents for parallel workstreams. Write Python scripts that call tools via RPC, collapsing multi-step pipelines into zero-context-cost turns.</td></tr>
<tr><td><b>Runs anywhere, not just your laptop</b></td><td>Six built-in terminal backends — local, Docker, SSH, Modal, Daytona, and Vercel Sandbox. Daytona and Modal offer serverless persistence — your agent's environment hibernates when idle and wakes on demand.</td></tr>
<tr><td><b>Research-ready</b></td><td>Batch trajectory generation, trajectory compression for training the next generation of tool-calling models.</td></tr>
</table>

## Documentation

All documentation lives upstream at **[hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/)** — quickstart, CLI reference, configuration, messaging gateway, security, tools, skills, memory, MCP, cron, and the developer guide. The upstream docs describe the identical core that this fork runs.

## License

MIT — see [LICENSE](LICENSE).

Built on [Hermes Agent](https://github.com/NousResearch/hermes-agent) by [Nous Research](https://nousresearch.com). This fork is a personal project and is not affiliated with or endorsed by Nous Research. Upstream bugs belong in the [upstream issue tracker](https://github.com/NousResearch/hermes-agent/issues); questions specific to this fork are welcome in its issue tracker.
