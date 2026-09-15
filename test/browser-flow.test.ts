/**
 * OAuth 回调服务的 state 校验测试。
 *
 * state 是防 CSRF 的唯一屏障：回调服务监听在本机端口上，任何本机进程都能
 * 向它构造请求。校验必须发生在拿 accessToken 去换临时密钥【之前】——否则
 * 伪造的回调也能让 CLI 白替它兑换一次真实密钥。这里用「后端地址指向一个
 * 必然失败的端口」来断言顺序：若 state 不匹配就被拒，就绝不会产生外发请求。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { startCallbackServer } from "../src/core/browser-flow.js";

const STATE = "0123456789abcdef";

/** 拼一条模拟授权后端回跳的 URL，query 名与中转后端回跳时一致 */
function callbackUrl(port: number, state: string): string {
  const q = new URLSearchParams({
    open_id: "oid-1",
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_at: "9999999999",
    state,
    site: "cn",
  });
  return `http://127.0.0.1:${port}/?${q.toString()}`;
}

describe("回调服务的 state 校验", () => {
  it("state 不匹配时回 400，且不去换临时密钥", async () => {
    const server = await startCallbackServer(STATE);
    // result 的 reject 必须有人接住，否则进程会因未处理的 rejection 退出
    const settled = server.result.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    try {
      const resp = await fetch(callbackUrl(server.port, "wrong-state"));
      assert.equal(resp.status, 400);
      assert.match(await resp.text(), /state mismatch/);
      // 报错信息应指向 state 而非网络失败——后者说明它已经去请求后端了
      const message = await settled;
      assert.match(message, /invalid state/);
      assert.doesNotMatch(message, /fetch|ECONNREFUSED|getaddrinfo/i);
    } finally {
      server.close();
    }
  });

  it("state 为空同样被拒（不能因空值短路跳过校验）", async () => {
    const server = await startCallbackServer(STATE);
    const settled = server.result.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    try {
      const resp = await fetch(callbackUrl(server.port, ""));
      assert.equal(resp.status, 400);
      assert.match(await settled, /invalid state/);
    } finally {
      server.close();
    }
  });

  it("state 匹配时才会继续走兑换流程", async () => {
    // 把兑换地址指到一个立即拒连的本机端口，避免真去连测试环境域名
    // （那会让本用例耗上十几秒的网络超时）
    process.env["THCLI_AUTH_BACKEND"] = "http://127.0.0.1:1";
    const server = await startCallbackServer(STATE);
    const settled = server.result.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    try {
      await fetch(callbackUrl(server.port, STATE)).catch(() => undefined);
      // 兑换必然失败；断言的是「失败原因不再是 state」，即校验已放行、
      // 流程确实推进到了 getTempCred
      const message = await settled;
      assert.doesNotMatch(message, /invalid state/);
    } finally {
      server.close();
      delete process.env["THCLI_AUTH_BACKEND"];
    }
  });
});
