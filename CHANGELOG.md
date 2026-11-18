# Changelog

## 2.0.0 — 2026-11-18

多源链路版本。

- 新增 `chain` 引擎：进程内路由，按序尝试、逐家冷却、失败换源、全挂回落 `bing`
- 新增 keyless 引擎：`exa` / `firecrawl` / `parallel` / `tinyfish`（MCP JSON-RPC + SSE 解析）
- 新增整次超时预算（`timeoutMs`）与单步上限（8 s），避免「插件超时、后端还在跑」
- 新增 10 分钟查询缓存，容量 100，最旧 20% 淘汰
- 新增额度类 429 长冷却（6 小时），避免反复重撞已耗尽的免费额度
- 变更：非 429 错误（401/403/5xx）也换源，坏 key 不再让整次搜索失败
- 变更：`chain` 默认链路为 `exa → firecrawl → parallel → tinyfish → bing`（不含需 key / 额度易耗尽的源）
- 修复：`engine=generic` 且无 key 时的误报警告「检索会返回 401」
- 新增：`scripts/install.ps1` / `uninstall.ps1`，支持重装 DSH 后一键恢复

## 1.0.0 — 2026-11-17

首个版本。

- 实现 `ctx.web.registerSearchProvider`，替换 DSH 默认搜索 provider
- 支持 `auto` / `bocha` / `tavily` / `searxng` / `bing` / `generic`
- 凭据优先从 `ctx.credentials` 解析，回落 `process.env`
- `bing` 兜底：解析 `cn.bing.com` 结果页，含 `/ck/a?u=a1...` 跳转解包
