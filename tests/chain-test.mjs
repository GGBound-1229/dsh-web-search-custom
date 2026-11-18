// 多源链路自检（真实联网，会消耗 keyless 额度）。
// 用法:
//   node tests/chain-test.mjs              # 默认链路 + 缓存
//   node tests/chain-test.mjs --quick      # 只跑默认链路一次
const src = await import("../index.js");

const QUERY = "希音 SHEIN 上市 招股书";

async function run(label, cfg, query) {
  const captured = [];
  const ctx = { web: { registerSearchProvider: (p) => captured.push(p) }, get: () => undefined };
  src.apply(ctx, { providerId: "custom", maxResults: 10, timeoutMs: 20000, ...cfg });
  const p = captured[0];
  const t0 = Date.now();
  try {
    const r = await p.search({ query, maxResults: 10 });
    console.log(`\n[${label}] OK ${Date.now() - t0}ms sources=${r.sources.length}`);
    r.sources.slice(0, 3).forEach((s) => console.log("  -", (s.title || "").slice(0, 48), "|", s.url.slice(0, 70)));
    return r;
  } catch (e) {
    console.log(`\n[${label}] FAIL ${Date.now() - t0}ms ${e.code}: ${String(e.message).slice(0, 200)}`);
    return null;
  }
}

await run("chain 默认链路", { engine: "chain" }, QUERY);
if (!process.argv.includes("--quick")) {
  await run("chain 默认链路（应为缓存命中 0ms）", { engine: "chain" }, QUERY);
  await run("chain 单引擎 exa", { engine: "chain", chain: ["exa"] }, QUERY);
  await run("chain 兜底 bing", { engine: "chain", chain: ["bing"] }, QUERY);
  // 无 key 的引擎应被跳过而不是报错
  await run("chain bocha(无key)→bing", { engine: "chain", chain: ["bocha", "bing"] }, QUERY);
}
