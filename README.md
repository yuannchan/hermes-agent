<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img src="assets/banner.png" alt="Holo — a personal, Windows-first fork of Hermes Agent" width="100%">
  </picture>
</p>

<p align="center">
  <em>「咱是约伊兹的贤狼赫萝。」</em><br>
  <sub>I am Holo, the wolf of Yoitsu. This is her cart: the same road as upstream, a different crest on the side.</sub>
</p>

<p align="center">
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/upstream-NousResearch%2Fhermes--agent-8A2BE2?style=flat-square" alt="Upstream: NousResearch/hermes-agent"></a>
  <a href="https://hermes-agent.nousresearch.com/docs/"><img src="https://img.shields.io/badge/docs-hermes--agent.nousresearch.com-FFD700?style=flat-square" alt="Documentation"></a>
  <a href="https://github.com/yuannchan/hermes-agent/releases"><img src="https://img.shields.io/github/v/release/yuannchan/hermes-agent?style=flat-square&label=release&color=a65c3b" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="#why-this-cart-exists">Why</a> ·
  <a href="#the-cargo-manifest">Changes</a> ·
  <a href="#the-road">Branches</a> ·
  <a href="#the-map">Layout</a> ·
  <a href="#boarding">Running</a> ·
  <a href="#the-caravan-we-travel-with">Upstream</a>
</p>

**Holo** is a personal, Windows-first fork of [Hermes Agent](https://github.com/NousResearch/hermes-agent), kept for one merchant's daily rounds. The agent core is untouched — the `hermes` command, gateway, tool system, skills and memory all behave exactly as upstream — while the desktop shell carries its own name, crest and palette, plus a handful of local fixes. The name comes from Holo, the wolf of Yoitsu in *Spice and Wolf*; the name is borrowed, the appetite for apples is not included.

## Why this cart exists

Every merchant needs a cart of their own. This one exists to:

- **Carry its own crest** — app name, icon, wordmark and theme are "Holo", so a patched build is never mistaken for the installed official app. Branding only; no behaviour hangs off the name.
- **Itemise the cargo** — every local fix is one reviewable commit with its own verification, stacked on a clean mirror of upstream.
- **Keep the road open** — `main` is upstream `main`, untouched. All local work sits on `local-fixes`, so upstream updates keep merging cleanly.

## The cargo manifest

### Desktop shell

| Area | Change |
|---|---|
| Identity | App name/wordmark "Holo", custom app icons, window and sign-in titles |
| Intro screen | App emblem + wordmark + neutral subtitle; stock intro copy matches upstream (brand word only) |
| Theme | Added a light "holo" preset (accent `#a65c3b`), with a matching dark-mode banner |
| Statusbar | 24px height keeps labels and icons fully visible at 90% UI zoom |
| Settings | About page shows version + local uninstall only — no built-in update channel; no shared metrics are collected or sent |
| Bundled plugins | Prebuilt `dist` bundles of plugin dashboards removed; dashboards are built on demand |

### Core fixes — one commit each, on `local-fixes`

| Commit | What it fixes |
|---|---|
| `fix(plugins)` | Snapshot plugin modules before concurrent eviction (race when a plugin is evicted while in use) |
| `fix(memory)` | The memory-review fork reads the live store, not the session-start snapshot |
| `fix(memory)` | Sanitise live memory entries before review |
| `fix(desktop)` | Repaint confirmed on primary model switch (stale model pill) |
| `fix(deps)` | Pin `av 18.1.0` alongside `faster-whisper 1.2.1` (binary compatibility) |

### Left as loaded

Agent loop, toolset system, skills, memory, gateway platforms, model routing, CLI commands and data layout are all upstream code. Anything not listed above was not touched.

## The road

Two branches, one direction of travel:

```
NousResearch/hermes-agent : main
            │
            │  mirror, no local commits
            ▼
     origin/main ─────────────► origin/local-fixes
                                         │
                                         │  main + reviewed local commits
                                         ▼
                                   runs on this machine
```

| Branch | Contents |
|---|---|
| `main` | Clean mirror of upstream `main` — no local changes |
| `local-fixes` | `main` + the reviewed local commits; this is what runs on the author's machine |
| remotes | `upstream` → `NousResearch/hermes-agent` · `origin` → this fork |

## The map

A monorepo root always looks like a market at dawn — every stall crowded into one square. The stalls that matter:

| Path | What lives there |
|---|---|
| `agent/`, `hermes_cli/`, `gateway/`, `hermes_platform/` | Agent loop, CLI commands, messaging gateway, platform adapters |
| `apps/desktop/` | Electron desktop app (renderer + main process) |
| `apps/shared/` | Shared TypeScript packages (incl. the compiled theme presets) |
| `plugins/`, `optional-mcps/` | Bundled first-party plugins and optional MCP servers |
| `skills/`, `optional-skills/` | The skill library shipped with the agent |
| `tests/`, `tests-js/`, `evals/` | Python and JS test suites, evaluation harnesses |
| `pm/`, `scripts/`, `tools/`, `docker/`, `nix/` | Developer tooling: PM package manager, CI/build scripts, containers, Nix flake |
| `ui-tui/`, `web/`, `website/`, `locales/` | Terminal UI, web chat, documentation site, translations |

Everything else at the root is build and config plumbing — `pyproject.toml`, lockfiles, the `Dockerfile`, and activation scripts for the PM-managed dev environment.

## Boarding

Personal builds are published under [Releases](https://github.com/yuannchan/hermes-agent/releases) — Windows MSIX, built for the author's own machines, not an officially supported distribution. The source also runs straight from the upstream developer workflow: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [developer guide](https://hermes-agent.nousresearch.com/docs/developer-guide/).

Looking for the official, supported application? Install [Hermes Agent](https://hermes-agent.nousresearch.com/) from upstream instead.

---

## The caravan we travel with

**Hermes Agent** is the self-improving AI agent built by [Nous Research](https://nousresearch.com): the only agent with a built-in learning loop — it creates skills from experience, improves them in use, nudges itself to persist knowledge, searches its own past conversations, and builds a deepening model of who you are across sessions. Run it on a $5 VPS, a GPU cluster, or serverless infrastructure that costs nearly nothing when idle; talk to it from Telegram while it works on a cloud VM.

Use any model you want — [Nous Portal](https://portal.nousresearch.com), OpenRouter, OpenAI, your own endpoint, and [many others](https://hermes-agent.nousresearch.com/docs/integrations/providers). Switch with `hermes model`; no code changes, no lock-in.

<table>
<tr><td><b>A real terminal interface</b></td><td>Full TUI with multiline editing, slash-command autocomplete, conversation history, interrupt-and-redirect, and streaming tool output.</td></tr>
<tr><td><b>Lives where you do</b></td><td>Telegram, Discord, Slack, WhatsApp, Signal and CLI — all from a single gateway process. Voice memo transcription, cross-platform conversation continuity.</td></tr>
<tr><td><b>A closed learning loop</b></td><td>Agent-curated memory with periodic nudges. Autonomous skill creation after complex tasks. FTS5 session search with LLM summarisation. <a href="https://agentskills.io">agentskills.io</a> open-standard skills.</td></tr>
<tr><td><b>Scheduled automations</b></td><td>Built-in cron scheduler with delivery to any platform — daily reports, nightly backups, weekly audits, all in natural language.</td></tr>
<tr><td><b>Delegates and parallelises</b></td><td>Isolated subagents for parallel workstreams; Python scripts that call tools over RPC, collapsing multi-step pipelines into zero-context-cost turns.</td></tr>
<tr><td><b>Runs anywhere</b></td><td>Six terminal backends — local, Docker, SSH, Modal, Daytona and Vercel Sandbox. Daytona and Modal hibernate when idle and wake on demand.</td></tr>
</table>

All documentation lives upstream at **[hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/)** — quickstart, CLI reference, configuration, gateway, security, tools, skills, memory, MCP, cron and the developer guide. It describes the identical core this fork runs.

## License

MIT — see [LICENSE](LICENSE).

Built on [Hermes Agent](https://github.com/NousResearch/hermes-agent) by [Nous Research](https://nousresearch.com). This fork is a personal project, not affiliated with or endorsed by Nous Research. Upstream bugs belong in the [upstream issue tracker](https://github.com/NousResearch/hermes-agent/issues); questions specific to this fork are welcome in its own tracker.

---

<p align="center"><sub>Wheat withers; the road doesn't. — <b>Holo</b> of Yoitsu &nbsp;·&nbsp; apples welcome</sub></p>
