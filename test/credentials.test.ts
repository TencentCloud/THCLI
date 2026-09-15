/**
 * 凭证解析测试。
 *
 * 核心是「整包三选一」这条安全性质：三元组必须同源，绝不跨源拼装。
 * 一旦被破坏就会拼出「永久 AK/SK + 别处的会话令牌」，签名必挂且极难排查——
 * 属于那种线上出问题最难定位的类型，所以必须锁死。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { mask, parseGlobalArgs, resolveSite } from "../src/core/credentials.js";
import { initLang, t } from "../src/core/i18n.js";

const ENV_KEYS = [
  "TENCENTCLOUD_SECRET_ID",
  "TENCENTCLOUD_SECRET_KEY",
  "TENCENTCLOUD_TOKEN",
  "TENCENTCLOUD_REGION",
  "THCLI_PROFILE",
  "THCLI_SITE",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
});

describe("整包三选一", () => {
  it("命令行给了 id+key 就锁定命令行层", () => {
    const c = parseGlobalArgs({ secretId: "AKIDcli", secretKey: "clikey" });
    assert.equal(c.source, "cli");
    assert.equal(c.secretId, "AKIDcli");
  });

  it("命令行层的 token 恒为空，不从下层补", () => {
    // 这是刻意设计：命令行不收 token（临时覆盖的用户手上是永久 AK/SK）。
    // 若从凭证文件补一个 OAuth token 上来，就拼出了必挂的混合凭证。
    const c = parseGlobalArgs({ secretId: "AKIDcli", secretKey: "clikey" });
    assert.equal(c.token, undefined, "命令行层不应带 token");
  });

  it("环境变量层整包生效，含 token", () => {
    process.env["TENCENTCLOUD_SECRET_ID"] = "AKIDenv";
    process.env["TENCENTCLOUD_SECRET_KEY"] = "envkey";
    process.env["TENCENTCLOUD_TOKEN"] = "envtoken";
    const c = parseGlobalArgs({});
    assert.equal(c.source, "env");
    assert.equal(c.token, "envtoken");
  });

  it("只给 id 不给 key 时该层不命中，继续往下找", () => {
    process.env["TENCENTCLOUD_SECRET_ID"] = "AKIDenv";
    const c = parseGlobalArgs({ secretId: "AKIDcli" });
    assert.notEqual(c.source, "cli", "只有 id 的层不该命中");
    assert.notEqual(c.source, "env", "只有 id 的层不该命中");
  });

  it("命令行优先于环境变量，且不混用两层的字段", () => {
    process.env["TENCENTCLOUD_SECRET_ID"] = "AKIDenv";
    process.env["TENCENTCLOUD_SECRET_KEY"] = "envkey";
    process.env["TENCENTCLOUD_TOKEN"] = "envtoken";
    const c = parseGlobalArgs({ secretId: "AKIDcli", secretKey: "clikey" });
    assert.equal(c.secretId, "AKIDcli");
    assert.equal(c.secretKey, "clikey");
    assert.equal(c.token, undefined, "不该借用 env 的 token");
  });
});

describe("region 独立回退", () => {
  it("region 与主凭证解耦，可单独由命令行指定", () => {
    const c = parseGlobalArgs({ region: "ap-shanghai" });
    assert.equal(c.region, "ap-shanghai");
  });

  it("命令行 region 优先于环境变量", () => {
    process.env["TENCENTCLOUD_REGION"] = "ap-beijing";
    const c = parseGlobalArgs({ region: "ap-shanghai" });
    assert.equal(c.region, "ap-shanghai");
  });

  it("无任何指定时有默认值", () => {
    const c = parseGlobalArgs({});
    assert.ok(c.region.startsWith("ap-"), `默认地域异常：${c.region}`);
  });
});

describe("site 解析", () => {
  it("命令行优先", () => {
    process.env["THCLI_SITE"] = "intl";
    assert.equal(resolveSite({ site: "cn" }), "cn");
  });

  it("环境变量次之", () => {
    process.env["THCLI_SITE"] = "intl";
    assert.equal(resolveSite({}), "intl");
  });
});

describe("mask", () => {
  it("留头 4 尾 4", () => {
    assert.equal(mask("AKID1234567890ab"), "AKID****90ab");
  });

  it("短值全遮，不泄露长度以外的信息", () => {
    assert.equal(mask("abc"), "***");
  });

  it("空值返回空串而不是 undefined 字样", () => {
    assert.equal(mask(undefined), "");
  });
});

describe("凭证来源的文案", () => {
  it("四种来源两种语言都有说明，且不含内部术语", () => {
    for (const lang of ["zh", "en"] as const) {
      initLang(lang);
      for (const key of ["cli", "env", "file", "none"] as const) {
        const label = t(`cred.source.${key}`);
        assert.notEqual(label, `cred.source.${key}`, `${lang}/${key} 缺文案（回显了键名）`);
        assert.ok(!/管控面|数据面/.test(label), `${lang}/${key} 的说明含内部术语`);
      }
    }
    initLang("zh");
  });
});
