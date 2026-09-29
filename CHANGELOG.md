# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).


## [2.1.0] - 2026-09-29

### Changed
- **Removed**: the standalone `opencode-tokens` CLI. The package no longer
  ships `bin/opencode-tokens`, the CLI commands (`today`, `budget`,
  `pricing`, `models`, `doctor`, `config`, `export`, `trend`), the CLI
  tests, the release helper script, or the GitHub Actions release
  workflow. The only user-facing surface is the OpenCode 2 TUI sidebar
  rendered through the `./tui` subpath export.
- **Plugin id**: the server-side plugin declares
  `id: "opencode-token-tracker-tui"`, matching the npm package name and
  the `./tui` subpath plugin id. Configure OpenCode with
  `plugins: ["opencode-token-tracker-tui"]`.
- **Ownership**: this project is fully owned and maintained by
  [EightDoor](https://github.com/EightDoor). The MIT `LICENSE` is
  re-attributed to EightDoor. The repository
  `EightDoor/opencode-token-tracker-tui` and the npm package
  `opencode-token-tracker-tui` are the canonical references for the
  project.
- **Release process**: publishing is performed locally by the owner with
  `npm publish --access public`. There is no automated GitHub Actions
  release workflow in this repository.
- **Documentation**: removed all references to the upstream project,
  including its GitHub URL, issue tracker, and CLI. This repository is
  the sole source of truth for the project.

### Migration notes
- Update `~/.config/opencode/config.json` so that `plugins` references
  `opencode-token-tracker-tui`.
- Anyone relying on the old CLI should read the JSONL log directly:
  - Token log: `~/.config/opencode/logs/token-tracker/tokens.jsonl`
  - Override paths via `TOKEN_TRACKER_LOG_FILE` /
    `TOKEN_TRACKER_CONFIG_FILE`.
- The `budget` section of `token-tracker.json` is no longer consulted by
  the plugin. It can be removed from your config or kept for your own
  reference — the plugin ignores it.