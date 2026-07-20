# Swarm attribution fixtures (synthetic)

These fixtures preserve the **structure** of real Claude Code requests captured during Phase 0,
without containing any real SIYAJ prompt content. They are used by Swarm attribution/validation
tests.

## Evidence provenance

- **Claude Code version captured:** `2.1.179 (Claude Code)`.
- **Capture method (Phase 0):** isolated modified CCR gateway on port 3458 with
  `observability.requestLogs = true`; Claude Code launched via an ephemeral `CLAUDE_CONFIG_DIR`
  whose `settings.json` pointed at the gateway; real delegations to planner/worker/reviewer
  subagents; bodies read from the isolated `request-logs.sqlite`. Real SIYAJ files were not
  modified; no secrets or absolute home paths were present in any captured body.

## Confirmed real request structure (frozen into canonicalization + attribution)

1. `body.system` is an **array of `{ type: "text", text }` blocks** (also handle the plain-string form).
2. `block[0]` is a short universal identity prefix
   (`"You are a Claude agent, built on Anthropic's Claude Agent SDK."`) — ignored.
3. For a **main/leader** session, `block[1]` is Claude Code's long interactive base prompt,
   which contains the stable anchor phrase
   `"You are an interactive agent that helps users with software engineering"`.
   Subagent requests do **not** contain this phrase.
4. For a **named subagent**, the agent-definition body is present **verbatim** as a system block,
   followed by ~1–1.5 KB of appended context (env/task). The body is a contiguous substring;
   substring containment therefore works.
5. The `<CCR-AGENT-MODEL>` marker is stripped by CCR before logging/forwarding; canonicalization
   strips it on both sides regardless.
6. `metadata.user_id` is present (`acct_session_<sessionId>`); the session id is extractable.

## Attribution contract (v1, exact-only)

Order: canonicalize → exact agent-body containment (1 match = exact; >1 = ambiguous; 0 = run
versioned leader detector → leader, else unknown). No fuzzy matching.

## Files

- `agents/*.md` — synthetic agent definitions (frontmatter + body; `dup-a`/`dup-b` share an
  identical body for collision tests).
- `requests/main-leader.json` — array form; leader base-prompt anchor present; no agent body.
- `requests/subagent-unknown.json` — array form; no registered agent body (ad-hoc task).
- `requests/system-string-form.json` / `system-array-form.json` — same content in the two system
  forms, to verify canonicalization is form-agnostic.
- Exact-match, ambiguous, and appended-context cases are built in tests from the agent fixtures
  (reading the body and embedding it) to avoid static-text drift.
