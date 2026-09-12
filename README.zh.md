[English](README.md) | 中文

# 给 DeepSeek Harness 插上知识库和数据库

`@busabase/dsh-plugin` 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接入 [Busabase](https://busabase.com/)，让 Agent 能读取可信知识、处理结构化数据，并把每一次写入提案交给人审阅。

它让 Agent 获得超越单次对话的长期上下文，但不会让 Agent 静默改写你的事实来源。

## 实际效果

观看 DeepSeek Harness 使用插件创建 CRM AirApp、提交变更供审阅，并在 Busabase 中打开结果。

[观看静音指南视频](./assets/busabase-dsh-plugin-guide.mp4)

## 快速开始

### 环境要求

- 与本包 peer dependencies 兼容的当前 DeepSeek Harness 版本；
- Node.js `>=24.18.0`；
- `PATH` 中可用 pnpm。

安装前不需要启动本地 Busabase。本地模式会按需启动 `busabase@latest`，或复用健康的 Busabase Personal Desktop 或本地服务；Cloud 模式会通过浏览器 OAuth 连接托管服务。

### 1. 安装插件

```bash
npx @deepseek-ai/dsh plugin --profile web add @busabase/dsh-plugin
```

安装包会自动激活 Host 和 Web 两端。经过审阅的 Skills 已经包含在 npm 包中，因此安装不需要授权生命周期脚本。安装验证、更新、删除和旧版本说明见 [安装与管理 npm Bundle](DEVELOPMENT.zh.md#安装与管理-npm-bundle)。

### 2. 选择本地或 Cloud

- **本地**是零配置默认模式，适合本机数据、免账号使用或 Busabase Personal Desktop。
- **Cloud**适合已有 Busabase 账号、团队工作区和多设备访问。把以下列表项加入 `$DSH_HOME/profiles/web/cordis.patch.yml`；默认路径是 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: busabase
  config:
    baseUrl: https://busabase.com
    serverName: busabase
```

如果文件中已有其他 row，请追加此项。不要把凭据写进文件；浏览器登录后，DeepSeek Harness 会把 OAuth 授权保存在凭据存储中。更新、验证、切换模式和故障处理见[完整的本地与 Cloud 设置指南](https://busabase.com/docs/deepseek-harness-plugin)。

### 3. 启动 DeepSeek Harness

```bash
npx @deepseek-ai/dsh --profile web
```

如果已经全局安装 `dsh`，可以用 `dsh` 替换 `npx @deepseek-ai/dsh`。打开 `http://127.0.0.1:3080/`。本地模式会等到实际需要时再启动 Busabase；Cloud 模式首次启动会打开浏览器 OAuth，之后复用已保存的授权。

### 4. 试一个任务

```text
创建一个客户跟进 Base，包含公司、联系人、阶段、预计金额、负责人、
下一步动作和跟进日期。把结构提交给我审阅。
```

本地模式下，如果还看不到完整 MCP 工具，请先调用 `busabase_start`；Cloud 模式先完成浏览器授权。Agent 会先检查现有工作区，再通过 ChangeRequest 提出 Base 结构。你查看差异并决定是否批准和合并；Cloud 提案请通过返回的 Busabase 正式链接审核。

## 为什么使用它

聊天上下文适合完成当前任务，却不适合作为长期数据系统。重要结论难以稳定复用，业务对象缺少结构，而 Agent 的一次误判也可能在被发现前污染文档或数据库。

这个插件为 DeepSeek Harness 增加四种能力：

- **可信知识：** 搜索已批准的 Docs、Files、Bases、Records、评论和关联对象；
- **结构化工作：** 把自然语言需求变成 Bases、Forms、AirApps 和记录的修改提案；
- **可用的结果：** 把 Busabase 实体显示成会话卡片和实时 Inspector，而不是大段 JSON；
- **人的控制权：** 把 Agent 写权限限制在 `changeRequest`，并默认要求用户重新确认每个审阅动作。

```text
DeepSeek Harness 负责理解任务与调用工具
                ↓
@busabase/dsh-plugin 负责把 Agent 接入 Busabase
                ↓
Busabase 负责保存已批准的知识和结构化数据
```

## 常见用法

- **团队知识：** 从已批准的产品文档、会议决策、研究资料和 FAQ 中检索答案，并返回可定位的来源。
- **研究整理：** 从访谈中提取证据、主题和优先级，先审阅提案记录，再决定是否合并。
- **业务数据库：** 用自然语言描述 CRM、项目跟踪、库存、招聘流程或运营台账。
- **内容运营：** 准备可审阅的文章、社交媒体内容、Newsletter、SEO 页面和本地化记录。
- **数据清洗：** 批量提出去重、标签、补全、分类、匹配或翻译建议。
- **工作区应用：** 围绕 Busabase 正式数据创建 Form 和 AirApp，并在 Inspector 中预览。

例如：

```text
查一下知识库中最新的企业版数据保留策略，给我来源文档，
并为存在冲突的 FAQ 记录提出修订。
```

Agent 可以读取已批准的策略并准备修订，但不能批准自己的修改。

## Approval-first 工作方式

```text
普通数据库
Agent ──直接写入──► 正式数据
                    错误已经生效

Busabase
Agent ──提出修改──► ChangeRequest ──人类审阅──► 正式数据
                    错误仍只是提案
```

MCP 连接权限固定在 `changeRequest`。Busabase 会拒绝 Agent 发起的批准、拒绝、关闭和合并操作，也不会让 `autoMerge: true` 绕过审阅。Inspector 中的审阅动作默认要求用户重新明确确认，工作区里存储的内容也只会被视为数据，而不是新的指令。高级配置可以关闭确认提示，但这不会提高服务端强制执行的 Agent 权限。

## 配置

默认配置会连接 `http://localhost:15419`，按需启动或复用 loopback 服务，启用 Inspector 实时刷新，并要求用户确认审阅动作。

如需使用其他地址、调整插件加载顺序，或修改服务与刷新行为，请查看 [完整配置参考](DEVELOPMENT.zh.md#完整配置参考)。

### 连接 Busabase Cloud

按 `id` 覆盖 Bundle row，并把 `baseUrl` 设置为 `https://` 的 Busabase Cloud 地址（根域名部署可配合 `spaceId`，或直接使用工作区子域名），即可连接到云端而不是本地服务：

```yaml
- id: busabase
  config:
    baseUrl: https://busabase.com
    serverName: busabase
```

插件不会管理或启动远程服务器。首次加载远程插件时会打开系统浏览器完成标准 OAuth 登录；DeepSeek Harness 通过其凭据存储保存生成的令牌，而不是写入本插件的配置。MCP 连接仍会固定发送 `changeRequest` 权限上限。当前版本中，Inspector 的审阅、合并、实时刷新以及 Base/AirApp 内嵌预览仍仅支持本地模式：请使用 Inspector 展示的 Busabase Cloud 正式链接，在云端查看、审阅与合并。

## 当前边界

- 默认面向单个本地 Busabase 工作区；
- 非 loopback `baseUrl` 在 `auto` 模式下会被视为外部服务，插件不会尝试启动它；
- 连接非 loopback 的 `https://` `baseUrl` 时使用基于浏览器的 OAuth，而不是本地中继，且 Inspector 的审阅、合并和实时刷新仍仅支持本地模式；
- `busabase_start` 启动服务并重新连接后，完整 MCP 工具才会可用（仅本地模式）；
- Agent 可以提出修改，但不能执行最终审阅和合并；
- Base 与 AirApp 预览需要正确的同源和 embed origin 配置；
- 关闭 iframe 后，实体元数据和“Open in Busabase”入口仍然可用。

## 文档

- [开发者指南](DEVELOPMENT.zh.md)：源码设置、架构、配置、安全内部实现、构建、打包和 E2E 测试；
- [Busabase 官网](https://busabase.com/)；
- [Busabase 开源仓库](https://github.com/busabase/busabase)；
- [Busabase Skills 与 MCP 接入](https://github.com/busabase/skills)；
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
