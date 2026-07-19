---
title: Swarm CLI
pageTitle: Swarm CLI
eyebrow: Guides
lead: Manage Swarm Profiles from the command line — create, validate, scan agents, launch sessions, and control per-agent model assignments without the desktop UI.
---

## Overview

The `ccr swarm` CLI provides full scriptable control over Swarm Profiles. It uses the same domain model, validation, persistence, and sanitization as the desktop app — no business logic is duplicated.

## Command Tree

```
ccr swarm list                              List all Swarm profiles
ccr swarm show <id>                         Show profile details
ccr swarm create [flags]                    Create a Swarm profile
ccr swarm update <id> [flags]               Update a Swarm profile
ccr swarm delete <id>                       Delete a Swarm profile
ccr swarm enable <id>                       Enable a Swarm profile
ccr swarm disable <id>                      Disable a Swarm profile
ccr swarm scan <id>                         Scan + refresh agent registry
ccr swarm validate <id>                     Validate profile assignments
ccr swarm diagnostics <id>                  Show diagnostics
ccr swarm sessions <id>                     List active sessions
ccr swarm launch <id>                       Launch Claude Code with Swarm session
ccr swarm stop <session-id>                 Stop a Swarm session

ccr swarm agent list <id>                   List agents in a Swarm
ccr swarm agent override <id> <slug>        Set provider/model override
ccr swarm agent clear <id> <slug>           Clear agent override
ccr swarm agent enable <id> <slug>          Enable an agent
ccr swarm agent disable <id> <slug>         Disable an agent
```

## Create

```bash
ccr swarm create \
  --name "My Project" \
  --workspace-root /home/user/projects/myproject \
  --launch-directory /home/user/projects/myproject/src \
  --agent-directory /home/user/projects/myproject/.claude/agents \
  --leader-provider "Claude Proxy" --leader-model "claude-fable-5" \
  --default-provider "Z.ai (Global) - Coding Plan" --default-model "glm-5.2" \
  --fallback-policy existing-ccr \
  --watch-files \
  --json
```

### Repeatable Flags

`--workspace-root` and `--agent-directory` are **repeatable**. Each occurrence adds another entry:

```bash
ccr swarm create --name X \
  --workspace-root /path/to/root1 \
  --workspace-root /path/to/root2 \
  --agent-directory /path/to/agents1 \
  --agent-directory /path/to/agents2 \
  ...
```

## Update

Omitted flags preserve existing values. Use explicit clear flags to remove optional fields:

```bash
# Change only the name
ccr swarm update swarm_abc123 --name "Renamed Project"

# Change fallback policy
ccr swarm update swarm_abc123 --fallback-policy fail-closed

# Clear the fallback assignment
ccr swarm update swarm_abc123 --clear-fallback

# Clear the description
ccr swarm update swarm_abc123 --clear-description
```

### Clear Semantics

| Flag | Effect |
|---|---|
| `--clear-description` | Sets description to "" |
| `--clear-fallback` | Clears fallback provider + model |
| Omitting a flag | Preserves existing value |

Empty strings are **never** treated as accidental clears.

## List and Show

```bash
# Human-readable table
ccr swarm list

# JSON output
ccr swarm list --json

# Show details
ccr swarm show swarm_abc123
```

## Scan and Validate

```bash
# Scan agent directory and build registry
ccr swarm scan swarm_abc123

# Validate provider/model assignments
ccr swarm validate swarm_abc123

# Full diagnostics
ccr swarm diagnostics swarm_abc123
```

## Agent Commands

```bash
# List all discovered agents
ccr swarm agent list swarm_abc123

# Set provider/model override (both required together)
ccr swarm agent override swarm_abc123 worker \
  --provider "Z.ai (Global) - Coding Plan" --model "glm-5.2"

# Clear override (restores frontmatter/default)
ccr swarm agent clear swarm_abc123 worker

# Disable an agent (remains visible, excluded from attribution)
ccr swarm agent disable swarm_abc123 worker

# Re-enable
ccr swarm agent enable swarm_abc123 worker
```

**Important**: Agent commands never modify the agent Markdown files. Overrides are persisted in the Swarm Profile's `agentOverrides` map.

## Launch and Stop

```bash
# Launch Claude Code in the configured directory with a Swarm session
ccr swarm launch swarm_abc123

# Stop a session
ccr swarm stop swrm_session_xyz

# List active sessions
ccr swarm sessions swarm_abc123
```

Launch validates the profile first. If validation fails, the command exits with code 1. On success, a Swarm Session is created and Claude Code is launched with the ephemeral Swarm token.

## JSON Output

All commands support `--json` for stable, machine-readable output:

```bash
ccr swarm list --json | jq '.[] | .name'
ccr swarm show swarm_abc123 --json | jq '.fallbackPolicy'
ccr swarm agent list swarm_abc123 --json | jq '.[] | .assignmentSource'
```

JSON output is **always sanitized** — it never includes raw tokens, token hashes, canonical bodies, full prompts, or provider credentials.

## Fallback Policies

| Policy | Behavior |
|---|---|
| `existing-ccr` | Swarm assignments/defaults are attempted. If none usable, fall through to existing CCR routing. |
| `swarm-default-required` | Direct assignment preferred. Swarm default is mandatory. If unavailable, **reject** (no CCR fallback). |
| `fail-closed` | CCR always forbidden. Only direct assignment accepted. Invalid → **reject**. |

When a route is **rejected**, the gateway returns HTTP 503 with `swarm_routing_rejected`. The provider is never invoked.

## Routing Precedence

1. Custom router (absolute)
2. Swarm agent UI override
3. Swarm agent frontmatter
4. Swarm leader
5. Swarm default (unknown/ambiguous)
6. CCR-AGENT-MODEL marker (compatibility, only when Swarm declines)
7. CCR-SUBAGENT-MODEL (compatibility)
8. Existing CCR routing

## Enabled Precedence

1. UI override (`agentOverrides[slug].enabled`)
2. Frontmatter `enabled` field
3. Default `true`

A disabled agent remains visible in the registry but is excluded from attribution.

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Validation or input error |
| 2 | Not found |
| 3 | Conflict (e.g. active sessions prevent delete) |
| 4 | Launch/runtime error |
| 5 | Controlled routing rejection |
| 10 | Unexpected internal error |

## Security Guarantees

- Never outputs raw Swarm session tokens
- Never outputs token hashes
- Never outputs canonical agent bodies
- Never outputs full system prompts
- Never outputs provider API credentials
- Never outputs helper paths containing token data
- Agent Markdown files are never modified by CLI commands

## Feature Flag

Swarm features require `swarm.enabled = true` in the CCR configuration. When disabled, all `ccr swarm` commands exit with code 1.

## Environment Variables

For isolated testing:

```
CCR_INTERNAL_HOME_DIR=<path>     Isolated config directory
CCR_INTERNAL_APP_DATA_DIR=<path> Isolated app-data directory
CCR_SWARM_FAKE_LAUNCH=1          Use FakeLaunchAdapter (no real Terminal/Claude)
```

## Example: Project-Specific Swarm

This example shows how to configure a multi-agent project (generic, not hardcoded to any specific project):

```bash
# Create the Swarm
ccr swarm create \
  --name "My Team" \
  --workspace-root /home/user/myteam \
  --launch-directory /home/user/myteam/src \
  --agent-directory /home/user/myteam/.claude/agents \
  --leader-provider "Claude Proxy" --leader-model "claude-fable-5" \
  --default-provider "Z.ai (Global) - Coding Plan" --default-model "glm-5.2" \
  --fallback-provider "ChatGPT Plus" --fallback-model "gpt-5.6-sol" \
  --fallback-policy existing-ccr \
  --json

# Scan agents
ccr swarm scan swarm_xxx

# Override a specific agent to a different model
ccr swarm agent override swarm_xxx reviewer \
  --provider "ChatGPT Plus" --model "gpt-5.6-sol"

# Validate
ccr swarm validate swarm_xxx

# Launch
ccr swarm launch swarm_xxx
```

### Agent File Format

Agent Markdown files in `.claude/agents/` use YAML frontmatter:

```markdown
---
name: worker
description: Implements scoped tasks.
provider: Z.ai (Global) - Coding Plan
providerId: zai-global
model: glm-5.2
enabled: true
---

# Worker

You implement tasks...
```

The `providerId` takes precedence over the display `provider` name. CLI overrides take precedence over frontmatter.
