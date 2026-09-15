/**
 * 账号身份缓存测试。
 *
 * 身份（uin/appId）由 cam:GetUserAppId 查得后缓存进凭证文件。这里不打真实网络，
 * 只钉住缓存的持久化行为——其中「续期不抹掉 identity」曾是真实缺陷：
 * saveCredential 整份重写凭证，而 maybeRefreshCredential 每次续期都调它，
 * 于是每续一次就丢一次缓存、下条命令又得多查一次 cam。
 *
 * 用子进程跑：core/paths.ts 在模块加载时就读定 HOME，同进程内改环境变量无效
 * （settings.test.ts 同样的隔离方式）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";

let home: string;
let credPath: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-identity-"));
  fs.mkdirSync(path.join(home, ".thcli"), { recursive: true });
  credPath = path.join(home, ".thcli", "default.cn.credential");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** 在隔离 HOME 的子进程里调 saveCredential，identityArg 为 undefined 则不传该参数 */
function runSave(identityArg?: string): void {
  const oauthModule = path.join(process.cwd(), "dist-test", "src", "core", "oauth.js");
  const script = `
    const { saveCredential } = await import(${JSON.stringify(oauthModule)});
    const token = { openId: "oid", accessToken: "at", refreshToken: "rt",
                    expiresAt: 9999999999, state: "", site: "cn" };
    const cred = { secretId: "AKIDnew", secretKey: "new", token: "tnew", expiresAt: 8888888888 };
    saveCredential(token, cred, "default", "cn", ${identityArg ?? "undefined"});
  `;
  execFileSync("node", ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

describe("凭证里的账号身份缓存", () => {
  it("续期时保留已缓存的 identity，同时更新密钥", () => {
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        type: "oauth",
        secretId: "AKIDold",
        secretKey: "old",
        expiresAt: 1,
        identity: { uin: "123", ownerUin: "123", appId: 456 },
      }),
    );

    runSave();

    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(after["identity"], { uin: "123", ownerUin: "123", appId: 456 });
    assert.equal(after["secretId"], "AKIDnew");
  });

  it("显式传入的 identity 覆盖文件里的旧值", () => {
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        type: "oauth",
        secretId: "AKIDx",
        secretKey: "k",
        identity: { uin: "old", ownerUin: "old", appId: 1 },
      }),
    );

    runSave('{ uin: "new", ownerUin: "new", appId: 2 }');

    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(after["identity"], { uin: "new", ownerUin: "new", appId: 2 });
  });

  it("没有 identity 时不写出该字段（而不是写个空对象）", () => {
    runSave();

    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, unknown>;
    assert.ok(!("identity" in after));
  });
});
