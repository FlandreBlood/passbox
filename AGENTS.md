# Passbox Developer Guide (`AGENTS.md`)

> Note: This file is repository-level contributor guidance for developing Passbox itself. It is intentionally placed at the repository root (not `rules/AGENTS.md`) so Antigravity never injects it into end-user runtime sessions when Passbox is installed.

## Architecture Invariants

Passbox implements **Architecture v0.3** (`ARCHITECTURE.md`) across six strictly bounded modules and six MCP tools:

1. **`src/interface/` (M1 Task Interface)**:
   - Exposes `passbox_delegate`, `passbox_collect`, `passbox_steer`, `passbox_status`, `passbox_recall`, `passbox_cancel` over stdio JSON-RPC 2.0 (`passbox_core` server).
   - Never injects LLM business judgments or automatic retry loops.
2. **`src/session/` (M2 Session Manager)**:
   - Manages `task_id` / `run_id` / `revision` lifecycles, detached worker processes (`run-worker.ts`), crash-recovery reconciliation, single-writer workspace protection, queued CLI steering, and `reset_context` thread rotation.
   - Transport timeouts or MCP `notifications/cancelled` never kill active background runs.
3. **`src/adapters/` (M3 Native Codex Adapter)**:
   - Invokes native `codex exec` and `codex exec resume` (`--json`, `--output-schema`, `-o`) without overriding `CODEX_HOME`, `HOME`, user `config.toml`, `AGENTS.md`, skills, plugins, MCP servers, or sandbox/approval settings.
   - Respects `codex exec resume` CLI flag asymmetry (never passing `-C`, `-s`, or `-a` on `resume`).
4. **`src/firewall/` (M4 Evidence Firewall)**:
   - Keeps `execution_status`, `reported_status`, and `verification_status` strictly separate.
   - Tags code/logs as `untrusted_artifact_data` and model claims (`blockers`, `counter_evidence`) as `verified: false`.
   - Enforces byte/line caps across all responses and errors (`512 B` status, `2 KiB` summary, `12 KiB / 300 lines` preview, `8 KiB` recall page, `32 KiB` hard ceiling).
5. **`src/evidence/` (M5 Evidence Collector)**:
   - Uses isolated temporary `GIT_INDEX_FILE` snapshots (`git add -A` + `git write-tree`) so `.git/index` and uncommitted user changes are never mutated.
   - Separates Codex execution diffs from `verify_commands` side-effects and external workspace drift.
6. **`src/observability/` (M6 Trace & Observability)**:
   - Stores immutable revisions, per-file diffs, verification logs, and raw visible NDJSON traces under `PLUGIN_DATA` (`PASSBOX_DATA_DIR` override supported for tests), with credential redaction and UTF-8-aligned cursor pagination.

## Development & Verification Commands

- Build runtime (`dist/`) and standalone plugin bundle (`dist/plugin-bundle/`):
  ```bash
  npm run build
  ```
- Run deterministic automated tests (mock Codex CLI + temporary Git repositories, zero paid model calls):
  ```bash
  npm test
  ```
- Validate Antigravity plugin manifests and components:
  ```bash
  npm run validate:plugin
  ```

## Prohibitions

- Never add runtime npm dependencies that require network installation when the host loads the plugin.
- Never write runtime task state inside `PLUGIN_ROOT` or inside target delegated repositories.
- Never introduce automatic LLM review gates, automatic rejection based on line/guard heuristics, or OAuth/API-key proxying.
