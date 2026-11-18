// 验证异步凭据解析：credentials 服务给 key 时应切到 bocha 分支。
// 用法: node tests/selftest-creds.mjs
const src = await import("../index.js");

const captured = [];
const fakeCtx = {
  get: (k) =>
    k === "credentials"
      ? { resolve: async () => ({ value: "sk-fake-from-credentials" }) }
      : undefined,
  web: { registerSearchProvider: (p) => captured.push(p) },
};

src.apply(fakeCtx, {
  providerId: "custom",
  engine: "auto",
  apiKeyEnv: "BOCHA_API_KEY",
  endpoint: "http://127.0.0.1:9/v1/web-search",
  timeoutMs: 3000,
  maxResults: 3,
});

const p = captured[0];
try {
  await p.search({ query: "test", maxResults: 3 });
  console.log("UNEXPECTED: 请求竟然成功了");
  process.exit(2);
} catch (e) {
  const msg = String(e.message || "");
  console.log("error:", msg.slice(0, 80));
  console.log(msg.startsWith("bocha") ? "PASS: 已按凭据切到 bocha 分支" : "FAIL: 未走 bocha 分支");
  if (!msg.startsWith("bocha")) process.exit(1);
}
