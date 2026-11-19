# dsh-web-search-custom

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

给 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) 的 `web_search` 换一个可插拔的搜索后端：
不再依赖 DeepSeek 官方账号、`DEEPSEEK_API_KEY` 或原生 `web_search_20250305` 服务端工具。

A bring-your-own search provider for DSH `ctx.web`. Supports Bing scraping, Bocha, Tavily, SearXNG,
any `POST {query,count}` endpoint, and four keyless MCP providers — with an in-process failover chain.

- 零依赖：只用全局 `fetch` / `AbortController` / `Buffer`
- 不改 DSH 核心：只实现 `ctx.web.registerSearchProvider`
- 多源链路：`exa → firecrawl → parallel → tinyfish → bing`，逐家冷却、失败换源、内置缓存
- 可回滚：删一段 YAML 就回到官方链路

---

## 为什么需要它

DSH 内置搜索链路是 `web_search → ctx.web → dsh-web-search-deepseek → Anthropic Messages + web_search_20250305`。
当对话模型走第三方中转（`openai-completions` 一类）时，这条链路有三处硬伤：

1. `web_search_20250305` 是 Anthropic Messages 的**服务端工具**，`openai-completions` 协议里没有这个字段，
   中转只转发不执行；
2. `resolveAccountToken` 只在会话 provider 为官方账号时返回 token，第三方 provider 下恒为 `undefined`；
3. `dsh-base` 把 `searchProvider` 硬编码成 `deepseek-official`。

这不是配置疏漏，是协议层缺失。唯一的解法是**换掉提供搜索的那一层**——也就是这个插件。

---

## 支持的引擎

| engine | 需要 key | 说明 |
|---|---|---|
| `auto` | 视情况 | 默认。有 key 走 `bocha`，否则回落 `bing` |
| `chain` | 视链路 | **多源串联**：按序尝试、逐家冷却、全挂回落 `bing` |
| `bocha` | 是 | [博查](https://open.bochaai.com)，国内直连，有免费额度 |
| `tavily` | 是 | [Tavily](https://tavily.com)，质量好，需能出网 |
| `searxng` | 否 | 自建 SearXNG，需在 `settings.yml` 的 `search.formats` 里开启 `json` |
| `bing` | 否 | 零配置兜底，解析 `cn.bing.com` 结果页 |
| `generic` | 视接口 | 任意 `POST {query,count}` 且返回 `results`/`data`/`items` 数组的接口 |
| `exa` | 否 | keyless MCP，语义检索质量高 |
| `firecrawl` | 否 | keyless MCP，抓取/结构化强 |
| `parallel` | 否 | keyless MCP，面向 Agent 场景 |
| `tinyfish` | 否 | keyless MCP，需 keyless 访问模式头 |

> `bing` 只适合「知道确切站点名」的查询。多词中文主题查询会被降级成字符级结果
> （例如「希音 SHEIN 上市 招股书」会返回「希」字字典页），所以它只做最后兜底。

---

## 安装

装进 DSH profile 的本质只有三步：**把包放进 `node_modules` → 把包名加进 `bundles` → 让 `web` 选到这个 provider。**
第三步是这个插件唯一特殊的地方：必须给 `dsh-web` 写一条 `- id: web` 覆盖。

### 方式一：克隆 + 脚本（推荐）

```powershell
git clone https://github.com/GGBound-1229/dsh-web-search-custom.git
cd dsh-web-search-custom
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本会：备份 → 复制插件到 profile → 写入 `package.json` 依赖与 bundle → 写入 `cordis.patch.yml`
两条覆盖（`- id: web` 与 `- id: web-search-custom`）→ 执行 `pnpm install`。

常用参数：

```powershell
# 预览，不落盘
.\scripts\install.ps1 -DryRun

# 换引擎 / 换链路
.\scripts\install.ps1 -Engine chain -Chain exa,firecrawl,bing
.\scripts\install.ps1 -Engine auto

# profile 不在默认位置
.\scripts\install.ps1 -ProfilePath 'D:\my-dsh-profile\desktop'
```

装完**重启 DSH** 生效。

### 方式二：pnpm 直接从 GitHub 装

```powershell
# Windows
cd $env:USERPROFILE\.dsh\profiles\desktop
```

```bash
# Linux / macOS
cd ~/.dsh/profiles/desktop
```

```bash
# 系统有 pnpm
pnpm add github:GGBound-1229/dsh-web-search-custom
```

```bash
# 系统有 npm，没 pnpm
npm install github:GGBound-1229/dsh-web-search-custom
```

然后手工补两处（**缺任何一处都不生效**）：

1. `package.json` 的 `dsh.profile.bundles` 里加包名：

   ```json
   "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     "dsh-web-search-custom"
   ]
   ```

   只加 `dependencies` 不加 `bundles`，包在磁盘上但 DSH 不会加载它。

2. `cordis.patch.yml` 末尾追加：

   ```yaml
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: custom
       fetchProvider: http

   - id: web-search-custom
     name: 'dsh-web-search-custom'
     config:
       providerId: custom
       engine: chain
       chain: ["exa", "firecrawl", "parallel", "tinyfish", "bing"]
       maxResults: 10
       timeoutMs: 20000
   ```

   第一条是**必须的**：`dsh-base` 默认把 `searchProvider` 写成 `deepseek-official`，
   不覆盖就永远选不到这个插件；第二条只是把插件自带的 `engine: auto` 换成多源链路。

3. 重启 DSH。

### 方式三：纯手动

1. 把本仓库复制到 `%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-web-search-custom\`
2. profile 的 `package.json` 加依赖并按上节加 `bundles`：

   ```jsonc
   {
     "dependencies": { "dsh-web-search-custom": "file:./plugins/dsh-web-search-custom" }
   }
   ```

3. 按上节追加两条 patch 覆盖。
4. 在 profile 目录执行 `pnpm install`，重启 DSH。

### 重装 DSH 后恢复

DSH 重装或重置 profile 会清空 `plugins/`、`package.json` 与 `cordis.patch.yml` 里的改动，插件随之消失。
恢复只需要三步：

```powershell
git clone https://github.com/GGBound-1229/dsh-web-search-custom.git
cd dsh-web-search-custom
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本按默认值重建 `chain` 链路（`exa → firecrawl → parallel → tinyfish → bing`），
要保留自定义链路或引擎就带上参数：

```powershell
.\scripts\install.ps1 -Engine chain -Chain exa,firecrawl,bing
.\scripts\install.ps1 -Engine auto
```

脚本可重复执行：每次先备份 `package.json.bak-*` / `cordis.patch.yml.bak-*`，再按 id 覆盖，
不会堆叠出多个 `- id: web-search-custom`。

---

## 配置

### 单引擎

```yaml
- id: web-search-custom
  config:
    engine: bocha          # 或 tavily / searxng / bing / auto
    apiKeyEnv: BOCHA_API_KEY
    maxResults: 10
    timeoutMs: 20000
```

### 多源链路

```yaml
- id: web-search-custom
  config:
    engine: chain
    chain: ["exa", "firecrawl", "parallel", "tinyfish", "bing"]
```

- 数组顺序即尝试顺序，某家失败/空结果就冷却并换下一家；
- 要固定某家：写成单元素数组；
- 想用博查打头：把 `bocha` 加到首位（没配 key 会被自动跳过，不报错）。

### 密钥

两种方式，`ctx.credentials` 优先，`process.env` 兜底：

```yaml
# %USERPROFILE%\.dsh\.credentials.yaml
refs:
  BOCHA_API_KEY: sk-xxx
  TAVILY_API_KEY: tvly-xxx
```

```powershell
setx BOCHA_API_KEY "sk-xxx"
```

凭据是**按次解析**的，改 `refs` 不用重启 DSH；改 `cordis.patch.yml` / 插件代码需要重启。

---

## 链路行为

| 项 | 值 |
|---|---|
| 单步超时 | 8 s |
| 整次预算 | `timeoutMs`（默认 20 s），到点即停，不会出现「插件超时、后端还在跑」 |
| 冷却 | 429 额度耗尽 6 h；429 其他 60 s；401/403/5xx 60 s；网络错误 30 s |
| 换源条件 | 任何失败都换（不限 429）——坏 key 不该让整次搜索失败 |
| 缓存 | 10 min，key = 查询词 + 条数 + 链路，满 100 条淘汰最旧 20% |
| 兜底 | 全链失败才落 `bing`，`bing` 也空才抛错 |

---

## 验证

在 DSH 里问一句需要实时信息的问题，或用这个判别查询：

```
希音 SHEIN 上市 招股书
```

- 返回港交所招股书 PDF / 证监会备案 / 财经媒体 → 链路正常
- 返回「希（汉语汉字）_百度百科」「希沃白板5」 → 还在用 `bing`，说明配置没生效或链路全挂

本机实测（2026-11-18）：`chain` 默认链路 `web_search` 2713 ms 返回 8 条，
结果集与直连 Exa 一致；同 query 二次命中缓存 0 ms。

本地也可以直接测插件，不用开 DSH：

```powershell
npm test              # bing 解析 + provider 注册
npm run test:chain    # 多源链路（真实联网，会消耗 keyless 额度）
npm run test:creds    # 凭据解析分支
```

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 搜索全挂，报 `WEB_PROVIDER_ERROR` | 链路全失败 | 看 DSH 启动日志里的 `chain=... failed`；先把 `chain` 改成 `["bing"]` 验证基础链路 |
| 结果全是字典/百科页 | 走了 `bing` | 检查 `engine` 是否为 `chain`，以及 patch 里是否有 `- id: web-search-custom` |
| 只有 8 条（配置 10） | 多数 keyless 端点上限 8 | 正常，`maxResults` 是上限不是保证 |
| 某家一直不命中 | 该家 429 冷却中 | 看日志 `cooldown=21600s` 即额度耗尽，等额度恢复 |
| 改配置没反应 | 插件配置在启动时读取 | 重启 DSH；只有 `.credentials.yaml` 的改动能热生效 |
| 启动后完全没有搜索能力 | 少了 `- id: web` 覆盖 | 补上 `searchProvider: custom`，再重启 |

DSH 不写运行日志文件，插件启动那行 `[web-search-custom] ... engine="chain" → chain(...)`
只出现在进程 stdout。

---

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

脚本会备份后移除插件、`package.json` 里的依赖与 bundle 条目、以及两条 patch 覆盖。
只想临时退回官方链路：把 `searchProvider` 改回 `deepseek-official`，或把 `engine` 改成 `auto`。

---

## 目录

```
.
├─ index.js              # 插件本体（引擎 + chain 路由）
├─ cordis.patch.yml      # 插件自带的 bundle patch（插入 provider 行）
├─ scripts/
│  ├─ install.ps1        # 安装 / 升级 / 修复
│  └─ uninstall.ps1      # 卸载
└─ tests/
   ├─ selftest.mjs       # bing 解析 + 注册
   ├─ chain-test.mjs     # chain 各分支
   └─ selftest-creds.mjs # 凭据解析
```

---

## 已知边界

- **keyless ≠ 匿名**：query 会明文发给对应厂商，隐私性不如固定用一家。
- **免费额度会衰减**：keyless 端点随时可能 403/429，冷却只是止损。
- **MCP 会话握手**：四家 keyless 目前按无状态端点调用，未实现 `initialize` / `Mcp-Session-Id`；
  若某家开始强制会话，那条源会退化为普通失败。
- **`fetchProvider` 独立**：网页抓取仍走 DSH 的 `http` provider，与搜索链路无关。

## License

MIT