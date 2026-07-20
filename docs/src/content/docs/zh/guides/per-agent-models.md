---
title: 按 Agent 指定模型
pageTitle: 按 Agent 指定模型
eyebrow: 指南
lead: 让每个 Claude Code 子 Agent 拥有自己的模型，且父 Agent 在委托给不同模型的子 Agent 后仍保持自己的模型。
---

## 为什么需要它

你希望每个 Agent 使用各自的模型——例如 Team Leader 用强推理模型，Worker 用快速编码模型，Reviewer 用第三个模型——并且希望父 Agent 在委托后**仍保持自己的模型**。仅靠会话模型无法做到这一点。

关键约束：**CCR 只能看到 Claude Code 发出的 HTTP 请求，而 Claude Code 从不会把当前执行 Agent 的名字（或 Agent 文件中的 `model:` frontmatter）放到请求里。** Claude Code 发出的子 Agent 信号只有一个内部的 `cc_is_subagent` 计费标记。因此，按 Agent 的声明必须“搭载”在 CCR *能读到* 的内容里——也就是 Agent 自己的系统提示词。

CCR 用一个**静态、确定性的标记**来解决：你在每个 Agent 文件中写一次。与协作式的 `<CCR-SUBAGENT-MODEL>` 标记（依赖*父*模型每次生成子 Agent 时自己选择并写入标记）不同，这个标记位于每个 Agent *自己*的提示词里，因此始终存在，不依赖父模型配合。

## 两种标记

两种标记都会从系统提示词（或前两条 user 消息）中读取，并在**转发前被移除**，上游模型永远看不到。

### 1. 文件内标记（推荐，优先级最高）

把完整的 `provider/model` 选择符直接写在 Agent 文件里。Agent 文件就是唯一事实来源。

```text
<CCR-AGENT-MODEL>provider/model</CCR-AGENT-MODEL>
```

### 2. 别名标记 + 中心映射

在 Agent 文件里写一个短别名，并在 CCR 配置里统一映射到模型。这样无需逐个编辑 Agent 文件即可在一个地方修改某个 Agent 的模型。

```text
<CCR-AGENT>worker</CCR-AGENT>
```

在 CCR 配置文件中映射别名（与其他设置放在一起）：

```json
{
  "agentModels": {
    "team-leader": "Claude Proxy/claude-fable-5",
    "worker": "Z.ai (Global) - Coding Plan/glm-5.2",
    "reviewer": "ChatGPT Plus/gpt-5.6-sol"
  }
}
```

匹配是大小写不敏感的，并会去除空白，因此 `<CCR-AGENT> Worker </CCR-AGENT>` 能匹配键 `worker`。

> **提示：** 优先使用文件内标记作为主要机制。`agentModels` 映射位于 CCR 的配置文件中；如果某个不带此功能的旧版 CCR 加载并重写了该配置，映射会被丢弃。而 `~/.claude/agents/` 中的标记在 CCR 配置生命周期之外，永远不会受影响。

## 优先级

请求到达时，CCR 按以下顺序解析模型（先命中者生效）：

1. **文件内标记** `<CCR-AGENT-MODEL>` → reason `builtin:claude-code-agent-model`
2. **别名标记** `<CCR-AGENT>` 经 `agentModels` 解析 → reason `builtin:claude-code-agent-slug`
3. 协作式 `<CCR-SUBAGENT-MODEL>` 标记（由父模型选择）
4. 请求中已存在的已知内联模型
5. 内置 Claude Code 配置模型
6. 路由规则
7. 默认 fallback

若配置了自定义路由（`CUSTOM_ROUTER_PATH`），它仍然优先于一切——而且你可以直接读取 `request.agentDeclaredModel` / `request.agentSlug`。

没有标记的 Agent 会回落到会话/配置模型，因此你可以自由混用声明了模型和未声明模型的 Agent。

## 完整示例

三个 Agent，三个模型。每个 Agent 文件位于 `~/.claude/agents/`。

**Team Leader → 推理模型**（`team-leader.md`）：

```markdown
---
name: team-leader
description: 负责编排团队并分派任务。
tools: Agent, Read, Write
---

<CCR-AGENT-MODEL>Claude Proxy/claude-fable-5</CCR-AGENT-MODEL>

你是 Team Leader。把工作拆分为任务并委派给专家。
```

**Worker → 快速编码模型**（`worker.md`）：

```markdown
---
name: worker
description: 实现任务。
---

<CCR-AGENT-MODEL>Z.ai (Global) - Coding Plan/glm-5.2</CCR-AGENT-MODEL>

你负责实现分配给你的任务。
```

**Reviewer → 审查模型**（`reviewer.md`）：

```markdown
---
name: reviewer
description: 审查已完成的工作。
---

<CCR-AGENT-MODEL>ChatGPT Plus/gpt-5.6-sol</CCR-AGENT-MODEL>

你从正确性和风险角度审查代码。
```

因为每个标记都位于该 Agent **自己**的系统提示词中，Team Leader 的请求始终携带它自己的标记，并始终路由到它自己的模型。委派给 Worker 不会改变 Leader 的提示词，因此 Leader 永远不会切换模型——正是你想要的行为。

等价的中心映射方案：在 Agent 文件里写 `<CCR-AGENT>team-leader</CCR-AGENT>` 等，并配合上面展示的 `agentModels` JSON。

## 注意事项

- 标记必须写在 Agent **正文**（即系统提示词）里，而不是 YAML frontmatter 里。Claude Code 不会把 frontmatter 发给 CCR。
- 选择符必须是 CCR 已知的模型：已配置的 `provider/model`（如 `Provider/model`）或已知的网关模型 id。未知的 provider 会被忽略，请求回落到会话模型。
- 字面量占位符 `provider/model` 会被忽略，因此你可以把它当作模板保留。
- 对于 Claude Code 流量，静态标记始终会被移除，因此即使内置 Claude Code 路由被禁用，它们也不会泄露给上游。
- 在请求日志中，被路由的请求会在 `resolved model` 显示所选模型，reason 为 `builtin:claude-code-agent-model` / `builtin:claude-code-agent-slug`。
