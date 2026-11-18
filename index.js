/**
 * dsh-web-search-custom
 *
 * 给 DSH 的 ctx.web 挂一个独立的 search provider，让 web_search 不再依赖
 * DeepSeek 官方的 Anthropic Messages + 原生 web_search server tool。
 *
 * 适配的引擎：
 *   bing      —— 无需 key，直连 cn.bing.com，最后兜底
 *   bocha     —— 博查 API，国内直连，需 key
 *   tavily    —— Tavily API，需 key
 *   searxng   —— 自建 SearXNG，需开 json 格式
 *   generic   —— 任意 POST {query,count} 的接口（如本地搜索网关）
 *   exa / firecrawl / parallel / tinyfish —— keyless MCP 端点
 *   chain     —— 上面的引擎串联：按顺序试、逐家冷却、全挂回落 bing
 *
 * 零依赖：只用全局 fetch / AbortController / Buffer，不 import 任何 @deepseek-ai 包。
 */

export const name = "web-search-custom";
export const inject = ["web"];

const DEFAULTS = {
  providerId: "custom",
  engine: "auto",
  maxResults: 10,
  timeoutMs: 20000,
  endpoint: "",
  apiKey: "",
  apiKeyEnv: "BOCHA_API_KEY",
};

/** chain 模式下单步上限；整次仍受 timeoutMs 约束。 */
const STEP_TIMEOUT = 8000;
const CACHE_TTL = 600000;
const MAX_CACHE = 100;
/** 默认链路：keyless 四家 + bing 兜底。要用博查/Tavily 就在 chain 数组里显式放首位。 */
const DEFAULT_CHAIN = ["exa", "firecrawl", "parallel", "tinyfish", "bing"];
const KEY_ENV = { bocha: "BOCHA_API_KEY", tavily: "TAVILY_API_KEY" };

/**
 * engine=auto 时按凭据情况选后端：
 *   解析到 key  → bocha（正规 API，质量可用）
 *   没有 key    → bing（零配置兜底，仅适合精确站点名查询）
 */
function pickEngine(name, key) {
  if (name !== "auto") return ENGINES[name] ?? ENGINES.generic;
  return key ? ENGINES.bocha : ENGINES.bing;
}

/** 反向查引擎标识，用在错误消息里，避免把配置名 "auto" 当成引擎名。 */
function nameOfEngine(engine) {
  for (const [k, v] of Object.entries(ENGINES)) if (v === engine) return k;
  return "generic";
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 配置字段可能是 plain value，也可能是 DSH 的响应式 ref（带 .get()）。两种都吃。 */
function opt(config, key, fallback) {
  let v = config?.[key];
  if (v && typeof v === "object" && typeof v.get === "function") v = v.get();
  if (v === undefined || v === null || v === "") return fallback;
  return v;
}

function resolveKey(config) {
  const literal = String(opt(config, "apiKey", "")).trim();
  if (literal) return literal;
  const envName = String(opt(config, "apiKeyEnv", "")).trim();
  if (envName && process.env[envName]) {
    const v = String(process.env[envName]).trim();
    if (v) return v;
  }
  return "";
}

/**
 * 凭据解析：优先走 DSH 的 ctx.credentials（Models 页写入的密钥在这里），
 * 再回落到进程环境变量。`available()` 是同步的，所以只在 search 里 await。
 */
async function resolveKeyAsync(ctx, config) {
  const literal = String(opt(config, "apiKey", "")).trim();
  if (literal) return literal;

  const envName = String(opt(config, "apiKeyEnv", DEFAULTS.apiKeyEnv)).trim();
  if (!envName) return "";

  const credentials = ctx?.get?.("credentials");
  if (credentials && typeof credentials.resolve === "function") {
    try {
      const resolved = await credentials.resolve(envName);
      const v = resolved?.value;
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      // 凭据域不可用时静默回落到环境变量
    }
  }
  return resolveKey(config);
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 把外层 signal 与本地超时合并成一个 signal，返回配套的清理函数。 */
function withTimeout(outer, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new Error(`search timed out after ${ms}ms`));
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose() {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
    },
  };
}

function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Bing 有时把结果包在 /ck/a?u=a1<base64url> 里，解回真实地址。 */
function unwrapBing(href) {
  try {
    const abs = href.startsWith("//") ? `https:${href}` : href;
    const u = new URL(abs, "https://cn.bing.com");
    if (u.hostname.endsWith("bing.com") && u.pathname === "/ck/a") {
      const raw = u.searchParams.get("u");
      if (raw && raw.startsWith("a1")) {
        const b64 = raw.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    return abs;
  } catch {
    return href;
  }
}

/** MCP 响应可能是 plain JSON-RPC，也可能是 SSE 帧，取 result 对象。 */
function parseMcp(text) {
  const body = String(text ?? "").trim();
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === "object" && obj.result) return obj.result;
  } catch {
    // 不是纯 JSON，继续按 SSE 拆
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const chunk = line.slice(5).trim();
    if (!chunk || chunk === "[DONE]") continue;
    try {
      const obj = JSON.parse(chunk);
      if (obj && typeof obj === "object" && obj.result) return obj.result;
    } catch {
      // 忽略坏帧
    }
  }
  throw new Error("no MCP result in response");
}

function mcpText(result) {
  for (const item of result?.content ?? []) {
    if (item?.type === "text" && item?.text) return item.text;
  }
  return "";
}

/** 从任意形状的 JSON 里挖出结果数组。 */
function pickArray(json) {
  const candidates = [
    json?.results,
    json?.data,
    json?.items,
    json?.list,
    json?.data?.results,
    json?.data?.list,
    json?.data?.items,
    json?.data?.webPages?.value,
    json?.webPages?.value,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  if (Array.isArray(json)) return json;
  return [];
}

/** 把各家字段别名归一成 dsh-tool-web 期望的形状。 */
function mapItem(it) {
  if (!it || typeof it !== "object") return null;
  const url = it.url || it.link || it.href || it.sourceUrl;
  if (typeof url !== "string" || url.length === 0) return null;
  if (/^(javascript|data|about):/i.test(url)) return null;
  return {
    url,
    title: String(it.title || it.name || it.siteName || url),
    snippet: String(it.snippet || it.content || it.summary || it.description || ""),
    publishedAt: it.publishedAt || it.published_date || it.datePublished || it.date || undefined,
  };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const MCP_ENDPOINTS = {
  exa: "https://mcp.exa.ai/mcp",
  firecrawl: "https://mcp.firecrawl.dev/v2/mcp",
  parallel: "https://search.parallel.ai/mcp",
  tinyfish: "https://agent.tinyfish.ai/mcp",
};

function mcpCall(provider, tool, args, extraHeaders = {}) {
  return {
    url: MCP_ENDPOINTS[provider],
    init: {
      method: "POST",
      headers: { ...MCP_HEADERS, "user-agent": UA, ...extraHeaders },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    },
  };
}

const ENGINES = {
  /** 无 key 兜底：解析 cn.bing.com 结果页。raw = 直接吃 HTML。 */
  bing: {
    raw: true,
    build({ query, count, key, endpoint }) {
      const u = new URL(endpoint || "https://cn.bing.com/search");
      u.searchParams.set("q", query);
      u.searchParams.set("count", String(Math.min(Math.max(count * 2, 10), 30)));
      u.searchParams.set("setlang", "zh-hans");
      return {
        url: u.toString(),
        init: {
          method: "GET",
          headers: {
            "user-agent": UA,
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            accept: "text/html,application/xhtml+xml",
            ...(key ? { cookie: key } : {}),
          },
        },
      };
    },
    parse(html) {
      const out = [];
      const parts = String(html).split(/<li class="b_algo"/i).slice(1);
      for (const part of parts) {
        const block = part.split(/<li class="b_algo"/i)[0].split("</li>")[0];
        const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!link) continue;
        const snippetMatch =
          block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
          block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ||
          block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
        out.push({
          url: unwrapBing(link[1]),
          title: stripHtml(link[2]),
          snippet: snippetMatch ? stripHtml(snippetMatch[1]) : "",
        });
      }
      return out;
    },
  },

  /** 博查 https://api.bochaai.com/v1/web-search —— 国内直连，有免费额度 */
  bocha: {
    needsKey: true,
    build({ query, count, key, endpoint }) {
      return {
        url: endpoint || "https://api.bochaai.com/v1/web-search",
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({ query, summary: true, count, page: 1 }),
        },
      };
    },
    parse(json) {
      const pages = json?.data?.webPages?.value ?? json?.webPages?.value ?? [];
      return pages.map((it) => ({
        url: it?.url,
        title: it?.name,
        snippet: it?.summary || it?.snippet,
        publishedAt: it?.datePublished,
      }));
    },
  },

  /** Tavily https://api.tavily.com/search */
  tavily: {
    needsKey: true,
    build({ query, count, key, endpoint }) {
      return {
        url: endpoint || "https://api.tavily.com/search",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: key,
            query,
            max_results: count,
            include_answer: false,
            search_depth: "basic",
          }),
        },
      };
    },
    parse(json) {
      return (json?.results ?? []).map((it) => ({
        url: it?.url,
        title: it?.title,
        snippet: it?.content,
        publishedAt: it?.published_date,
      }));
    },
  },

  /** 自建 SearXNG，需在 settings.yml 的 search.formats 里加 json */
  searxng: {
    build({ query, key, endpoint }) {
      const u = new URL(endpoint || "http://127.0.0.1:8080/search");
      u.searchParams.set("q", query);
      u.searchParams.set("format", "json");
      return {
        url: u.toString(),
        init: {
          method: "GET",
          headers: key ? { authorization: `Bearer ${key}` } : {},
        },
      };
    },
    parse(json) {
      return (json?.results ?? []).map((it) => ({
        url: it?.url,
        title: it?.title,
        snippet: it?.content,
        publishedAt: it?.publishedDate,
      }));
    },
  },

  /** 任意 POST {query,count} 且返回 results/data/items 数组的接口 */
  generic: {
    build({ query, count, key, endpoint }) {
      if (!endpoint) throw fail("generic engine requires config.endpoint", "WEB_PROVIDER_ERROR");
      return {
        url: endpoint,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({ query, count }),
        },
      };
    },
    parse(json) {
      return pickArray(json);
    },
  },

  /** Exa keyless MCP，返回带 URL:/Title:/Highlights 的文本块 */
  exa: {
    keyless: true,
    raw: true,
    build({ query, count }) {
      return mcpCall("exa", "web_search_exa", { query, numResults: Math.min(count, 8) });
    },
    parse(text) {
      const body = mcpText(parseMcp(text)).replace(/\r\n/g, "\n");
      const out = [];
      for (const block of body.split(/\n\s*---\s*\n/)) {
        const url = block.match(/^URL:\s*(.+)$/m);
        if (!url) continue;
        const title = block.match(/^Title:\s*(.+)$/m);
        const published = block.match(/^Published:\s*(.+)$/m);
        const content = block.match(/^(?:Highlights|Text|Snippet):\s*\n?([\s\S]*)$/m);
        out.push({
          url: url[1],
          title: title ? title[1] : undefined,
          snippet: content ? content[1] : "",
          publishedAt: published ? published[1] : undefined,
        });
      }
      return out;
    },
  },

  /** Firecrawl keyless MCP */
  firecrawl: {
    keyless: true,
    raw: true,
    build({ query, count }) {
      return mcpCall("firecrawl", "firecrawl_search", { query, limit: Math.min(count, 8) });
    },
    parse(text) {
      const obj = JSON.parse(mcpText(parseMcp(text)));
      const web = obj?.data?.web ?? [];
      return web.map((it) => ({ url: it?.url, title: it?.title, snippet: it?.description }));
    },
  },

  /** Parallel keyless MCP */
  parallel: {
    keyless: true,
    raw: true,
    build({ query }) {
      return mcpCall("parallel", "web_search", { objective: query, search_queries: [query] });
    },
    parse(text) {
      const result = parseMcp(text);
      let items = result?.structuredContent?.results;
      if (!items) {
        try {
          items = JSON.parse(mcpText(result)).results ?? [];
        } catch {
          items = [];
        }
      }
      return (items ?? []).map((it) => ({
        url: it?.url,
        title: it?.title,
        snippet: (it?.excerpts ?? []).join("\n\n"),
        publishedAt: it?.publish_date,
      }));
    },
  },

  /** TinyFish keyless MCP（需 keyless 访问模式头） */
  tinyfish: {
    keyless: true,
    raw: true,
    build({ query }) {
      return mcpCall("tinyfish", "search", { query }, { "x-tinyfish-access-mode": "keyless" });
    },
    parse(text) {
      const obj = JSON.parse(mcpText(parseMcp(text)));
      return (obj?.results ?? []).map((it) => ({
        url: it?.url,
        title: it?.title,
        snippet: it?.snippet,
      }));
    },
  },
};

// --------------------------------------------------------------------------
// chain：进程内路由（冷却 / 缓存 / 预算），不依赖外部网关
// --------------------------------------------------------------------------

const COOLDOWN = new Map();
const CACHE = new Map();

function cooling(id) {
  const until = COOLDOWN.get(id) ?? 0;
  if (until <= Date.now()) {
    COOLDOWN.delete(id);
    return false;
  }
  return true;
}

function cool(id, ms) {
  const until = Date.now() + ms;
  if ((COOLDOWN.get(id) ?? 0) < until) COOLDOWN.set(id, until);
}

/** 429 且 body 显示额度耗尽 → 长冷却；其余按状态码给默认值。 */
function cooldownOf(err) {
  const status = Number(err?.status ?? 0);
  const body = String(err?.body ?? "").toLowerCase();
  if (status === 429 && /daily_cap|daily limit|quota|credit|insufficient/.test(body)) return 6 * 3600000;
  if (status === 429) return 60000;
  if (status === 403) return 60000;
  if (status >= 500) return 60000;
  if (status === 0) return 30000;
  return 10000;
}

function normalizeChain(raw) {
  let list = raw;
  if (typeof list === "string") list = list.split(",");
  if (!Array.isArray(list) || list.length === 0) list = DEFAULT_CHAIN;
  return list
    .map((item) => {
      if (typeof item === "string") {
        const id = item.trim().toLowerCase();
        return id && ENGINES[id] && id !== "chain" ? { engine: id, apiKeyEnv: KEY_ENV[id] ?? "", endpoint: "" } : null;
      }
      if (item && typeof item === "object" && item.engine) {
        const id = String(item.engine).toLowerCase();
        if (!ENGINES[id] || id === "chain") return null;
        return {
          engine: id,
          apiKeyEnv: item.apiKeyEnv ?? KEY_ENV[id] ?? "",
          endpoint: item.endpoint ?? "",
        };
      }
      return null;
    })
    .filter(Boolean);
}

async function fetchEngine(o, entry, query, count, signal, timeoutMs) {
  const engine = ENGINES[entry.engine];
  const key = entry.apiKeyEnv ? await resolveKeyAsync(o.ctx, { apiKeyEnv: entry.apiKeyEnv }) : "";
  if (engine.needsKey && !key) {
    throw fail(`${entry.engine}: no api key (${entry.apiKeyEnv || "-"})`, "WEB_PROVIDER_SKIP");
  }
  const built = engine.build({ query, count, key, endpoint: entry.endpoint || o.endpoint });

  const t = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(built.url, { ...built.init, signal: t.signal, redirect: "follow" });
    const text = await res.text();
    if (!res.ok) {
      const err = fail(`${entry.engine} HTTP ${res.status}: ${text.slice(0, 200)}`, "WEB_PROVIDER_ERROR");
      err.status = res.status;
      err.body = text;
      throw err;
    }
    const items = engine.raw === true ? engine.parse(text) : engine.parse(JSON.parse(text));
    return dedupe(items.map(mapItem)).slice(0, count);
  } finally {
    t.dispose();
  }
}

async function runChain(o, query, count, signal) {
  const chain = normalizeChain(o.chain);
  const cacheKey = `${query.trim().toLowerCase()}|${count}|${chain.map((e) => e.engine).join(",")}`;
  const hit = CACHE.get(cacheKey);
  if (hit && hit.until > Date.now()) return { sources: hit.sources, truncated: false };

  const deadline = Date.now() + o.timeoutMs;
  const attempts = [];

  for (const entry of chain) {
    const remain = deadline - Date.now();
    if (remain < 800) {
      attempts.push(`${entry.engine}: deadline`);
      break;
    }
    if (cooling(entry.engine)) {
      attempts.push(`${entry.engine}: cooling`);
      continue;
    }
    const started = Date.now();
    try {
      const sources = await fetchEngine(o, entry, query, count, signal, Math.min(STEP_TIMEOUT, remain));
      const elapsed = Date.now() - started;
      if (sources.length > 0) {
        console.log(`[web-search-custom] chain=${entry.engine} ${elapsed}ms results=${sources.length}`);
        if (CACHE.size >= MAX_CACHE) {
          const drop = [...CACHE.entries()]
            .sort((a, b) => a[1].until - b[1].until)
            .slice(0, Math.floor(MAX_CACHE / 5));
          for (const [k] of drop) CACHE.delete(k);
        }
        CACHE.set(cacheKey, { until: Date.now() + CACHE_TTL, sources });
        return { sources, truncated: false };
      }
      attempts.push(`${entry.engine}: empty`);
      cool(entry.engine, 10000);
    } catch (e) {
      if (e?.code === "WEB_PROVIDER_SKIP") {
        attempts.push(e.message);
        continue;
      }
      const delay = cooldownOf(e);
      cool(entry.engine, delay);
      attempts.push(String(e?.message ?? e).slice(0, 160));
      console.warn(
        `[web-search-custom] chain=${entry.engine} failed cooldown=${Math.round(delay / 1000)}s ` +
          `err=${String(e?.message ?? e).slice(0, 160)}`,
      );
      if (signal?.aborted) break;
    }
  }

  throw fail(`chain exhausted: ${attempts.join("; ")}`, "WEB_PROVIDER_ERROR");
}

// --------------------------------------------------------------------------

function createProvider(read) {
  return {
    get id() {
      return read().providerId;
    },

    /** 注册即视为可用；真正的失败在 search 里以结构化错误暴露。 */
    available() {
      return true;
    },

    async search(request, signal) {
      const o = read();
      const query = String(request?.query ?? "").trim();
      if (!query) throw fail("query must be a non-empty string", "WEB_SEARCH_EMPTY_QUERY");

      const count = Math.min(Math.max(Number(request?.maxResults ?? o.maxResults) || 10, 1), 50);

      if (o.engine === "chain") {
        return runChain(o, query, count, signal);
      }

      const key = await resolveKeyAsync(o.ctx, o.config);
      const engine = pickEngine(o.engine, key);
      const engineId = nameOfEngine(engine);

      let built;
      try {
        built = engine.build({ query, count, key, endpoint: o.endpoint });
      } catch (e) {
        throw fail(`${engineId}: ${e.message}`, e.code || "WEB_PROVIDER_ERROR");
      }

      const t = withTimeout(signal, o.timeoutMs);
      let res;
      let text;
      try {
        res = await fetch(built.url, { ...built.init, signal: t.signal, redirect: "follow" });
        text = await res.text();
      } catch (e) {
        t.dispose();
        if (signal?.aborted) throw fail("search aborted", "WEB_ABORTED");
        throw fail(`${engineId} request failed: ${e?.message ?? e}`, "WEB_PROVIDER_ERROR");
      }
      t.dispose();

      if (!res.ok) {
        throw fail(
          `${engineId} HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
          "WEB_PROVIDER_ERROR",
        );
      }

      let payload;
      if (engine.raw === true) {
        payload = text;
      } else {
        try {
          payload = JSON.parse(text);
        } catch {
          throw fail(
            `${engineId} returned a non-JSON body: ${text.slice(0, 200)}`,
            "WEB_PROVIDER_ERROR",
          );
        }
      }

      const sources = dedupe(engine.parse(payload).map(mapItem)).slice(0, count);
      return { sources, truncated: false };
    },
  };
}

export function apply(ctx, config) {
  const read = () => ({
    providerId: String(opt(config, "providerId", DEFAULTS.providerId)),
    engine: String(opt(config, "engine", DEFAULTS.engine)).toLowerCase(),
    maxResults: Number(opt(config, "maxResults", DEFAULTS.maxResults)) || DEFAULTS.maxResults,
    timeoutMs: Number(opt(config, "timeoutMs", DEFAULTS.timeoutMs)) || DEFAULTS.timeoutMs,
    endpoint: String(opt(config, "endpoint", "")),
    chain: opt(config, "chain", null),
    config,
    ctx,
  });

  const snapshot = read();
  const key = resolveKey(snapshot.config);
  const engineName =
    snapshot.engine === "chain"
      ? `chain(${normalizeChain(snapshot.chain).map((e) => e.engine).join(" > ")})`
      : snapshot.engine === "auto"
        ? key
          ? "bocha"
          : "bing"
        : snapshot.engine;

  console.log(
    `[web-search-custom] provider="${snapshot.providerId}" engine="${snapshot.engine}" ` +
      `→ ${engineName} | endpoint="${snapshot.endpoint || "(default)"}" ` +
      `key=${key ? "resolved" : "none"} maxResults=${snapshot.maxResults} timeout=${snapshot.timeoutMs}ms`,
  );
  if (snapshot.engine === "auto" && !key) {
    console.warn(
      `[web-search-custom] 未解析到搜索 API key，已回落到 bing HTML 解析。` +
        `该模式仅适合精确站点名查询，多词主题查询会被降级成泛化结果。` +
        `配置 ${DEFAULTS.apiKeyEnv} 后自动切到 bocha。`,
    );
  }
  const noKeyWarn =
    snapshot.engine !== "searxng" &&
    snapshot.engine !== "bing" &&
    snapshot.engine !== "auto" &&
    snapshot.engine !== "chain" &&
    snapshot.engine !== "generic";
  if (!key && noKeyWarn) {
    console.warn(
      `[web-search-custom] engine=${snapshot.engine} 但没解析到 key，` +
        `检索会返回 401。检查 config.apiKeyEnv 与凭据 refs 里的引用名。`,
    );
  }

  ctx.web.registerSearchProvider(createProvider(read));

  // 凭据可能只存在于 ctx.credentials（异步），补充一条准确的生效提示。
  if (snapshot.engine === "auto") {
    resolveKeyAsync(ctx, snapshot.config)
      .then((resolved) => {
        if (resolved) {
          console.log("[web-search-custom] 凭据已从 credentials 解析，实际引擎：bocha");
        }
      })
      .catch(() => {});
  }
}
