---
title: Per-Agent Model Routing
pageTitle: Per-Agent Model Routing
eyebrow: Guides
lead: Give every Claude Code subagent its own model, deterministically, so a parent agent keeps its model even after delegating to children on different models.
---

## Why this exists

You want each agent on its own model — for example a Team Leader on a strong reasoning model, workers on a fast coding model, and a reviewer on a third model — and you want the parent to **stay on its own model** after it delegates. The session model alone cannot do this.

The important constraint: **CCR only sees the HTTP request Claude Code sends, and Claude Code never puts the executing agent's name (or the agent file's `model:` frontmatter) on the wire.** The only subagent signal Claude Code sends is an internal `cc_is_subagent` billing flag. So a per-agent declaration has to ride inside the request in something CCR *can* read — the agent's own system prompt.

CCR solves this with a **static, deterministic marker** you place once in each agent file. Unlike the cooperative `<CCR-SUBAGENT-MODEL>` tag (where the *parent* LLM must choose and emit a tag every time it spawns a child), this marker lives in each agent's *own* prompt, so it is always present and never depends on the parent cooperating.

## The two markers

Both markers are read from the agent's system prompt (or the first two user messages) and **stripped before the request is forwarded**, so providers never see them.

### 1. Per-file marker (recommended, highest precedence)

Put the full `provider/model` selector directly in the agent file. The agent file is the single source of truth.

```text
<CCR-AGENT-MODEL>provider/model</CCR-AGENT-MODEL>
```

### 2. Slug marker + central map

Put a short slug in the agent file, and map it to a model once in CCR's config. Change an agent's model in one place without editing agent files.

```text
<CCR-AGENT>worker</CCR-AGENT>
```

Map the slug in the CCR config file (alongside your other settings):

```json
{
  "agentModels": {
    "team-leader": "Claude Proxy/claude-fable-5",
    "worker": "Z.ai (Global) - Coding Plan/glm-5.2",
    "reviewer": "ChatGPT Plus/gpt-5.6-sol"
  }
}
```

Lookup is case-insensitive and trims whitespace, so `<CCR-AGENT> Worker </CCR-AGENT>` matches the key `worker`.

> **Tip:** prefer the per-file marker as your primary mechanism. The `agentModels` map lives in CCR's config file; if an older CCR build without this feature ever loads and rewrites that config, the map is dropped. Markers in `~/.claude/agents/` are outside CCR's config lifecycle and are never affected.

## Precedence

When a request arrives, CCR resolves the model in this order (first match wins):

1. **Per-file marker** `<CCR-AGENT-MODEL>` → reason `builtin:claude-code-agent-model`
2. **Slug marker** `<CCR-AGENT>` resolved via `agentModels` → reason `builtin:claude-code-agent-slug`
3. Cooperative `<CCR-SUBAGENT-MODEL>` tag (parent-chosen)
4. Inline known model already in the request
5. Built-in Claude Code profile model
6. Routing rules
7. Default fallback

The custom router (`CUSTOM_ROUTER_PATH`), if configured, still wins over everything — and it can read `request.agentDeclaredModel` / `request.agentSlug` directly if you want it to.

Agents with no marker fall through to the session/profile model, so you can mix declared and undeclared agents freely.

## Worked example

Three agents, three models. Each agent file lives in `~/.claude/agents/`.

**Team Leader → reasoning model** (`team-leader.md`):

```markdown
---
name: team-leader
description: Orchestrates the team and delegates work.
tools: Agent, Read, Write
---

<CCR-AGENT-MODEL>Claude Proxy/claude-fable-5</CCR-AGENT-MODEL>

You are the team leader. Break work into tasks and delegate to specialists.
```

**Worker → fast coding model** (`worker.md`):

```markdown
---
name: worker
description: Implements tasks.
---

<CCR-AGENT-MODEL>Z.ai (Global) - Coding Plan/glm-5.2</CCR-AGENT-MODEL>

You implement tasks you are given.
```

**Reviewer → review model** (`reviewer.md`):

```markdown
---
name: reviewer
description: Reviews completed work.
---

<CCR-AGENT-MODEL>ChatGPT Plus/gpt-5.6-sol</CCR-AGENT-MODEL>

You review code for correctness and risks.
```

Because each marker lives in the agent's **own** system prompt, the Team Leader's requests always carry its own marker and always route to its model. Delegating to a worker never changes the leader's prompt, so the leader never switches models — exactly the behavior you want.

The equivalent central-map setup uses `<CCR-AGENT>team-leader</CCR-AGENT>` etc. in the agent files plus the `agentModels` JSON shown above.

## Notes

- The marker must be in the agent **body** (which becomes the system prompt), not in the YAML frontmatter. Claude Code does not send frontmatter to CCR.
- The selector must be a model CCR knows: either a configured provider/model pair (e.g. `Provider/model`) or a known gateway model id. An unknown provider is ignored and the request falls through to the session model.
- `provider/model` (the literal placeholder text) is ignored so you can leave it as a template.
- Static markers are always stripped for Claude Code traffic, so they cannot leak to the provider even if the built-in Claude Code route is disabled.
- In request logs, routed requests show the chosen model under `resolved model` and the reason `builtin:claude-code-agent-model` / `builtin:claude-code-agent-slug`.
