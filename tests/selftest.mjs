// 自检：bing 引擎在当前网络下能否出结果，provider 是否正确注册。
// 用法: node tests/selftest.mjs
const src = await import("../index.js");

const captured = [];
const fakeCtx = {
  web: {
    registerSearchProvider(p) {
      captured.push(p);
    },
  },
};

src.apply(fakeCtx, {
  providerId: "custom",
  engine: "bing",
  maxResults: 5,
  timeoutMs: 15000,
});

if (captured.length !== 1) {
  console.error("FAIL: provider 未注册");
  process.exit(1);
}

const p = captured[0];
console.log("provider.id =", p.id, "| available() =", p.available());

const t0 = Date.now();
try {
  const r = await p.search({ query: "OpenCode web search", maxResults: 5 });
  console.log(`OK ${Date.now() - t0}ms, sources=${r.sources.length}`);
  for (const s of r.sources.slice(0, 5)) {
    console.log("-", s.title.slice(0, 60));
    console.log("  ", s.url);
    if (s.snippet) console.log("  ", s.snippet.slice(0, 100));
  }
  if (r.sources.length === 0) {
    console.error("FAIL: 解析出 0 条，HTML 结构可能变了");
    process.exit(2);
  }
} catch (e) {
  console.error("FAIL:", e.code || "", e.message);
  process.exit(3);
}
