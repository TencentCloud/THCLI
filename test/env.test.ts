/**
 * 环境解析与注入测试。
 *
 * 代码只内置 prod，其余环境由用户在 ~/.thcli/config.json 里声明（私有网络地址、集群 IP
 * 这类基础设施信息不进仓库——src/ 会被 bundle 进 dist/main.cjs 随包公开）。所以这里
 * 测的不是"内置了哪几个环境"，而是**用户配置能否被正确加载并生效**：那条链路断了，
 * 自建的测试环境会静默回落到 prod，拿测试凭证打生产、报错还看不出根因。
 *
 * EnvConfig 各字段里最容易回归的是 routeByUserId：缺了会让非广州地域全部返回
 * InternalError（那个报错完全看不出根因），多注入到正式环境又是无谓的账号信息外泄，
 * 两个方向都得钉住。
 *
 * config.ts 的配置是模块级缓存、同进程内无法重载，因此走子进程 + 临时 HOME
 * （与 settings.test.ts 同一套路）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  allowedEnvs,
  apiEndpointOf,
  allowedRegions,
  chatHostOf,
  cloudApiHostOf,
  DEFAULT_ENV,
  envConfigOf,
  cloudApiHostIpOf,
  insecureTlsOf,
} from "../src/core/config.js";
import { resolveEnv } from "../src/core/credentials.js";

const CLI = path.join(process.cwd(), "dist", "main.cjs");
let home: string;

/**
 * 一份自定义环境配置。刻意用文档示例网段（RFC 5737 的 203.0.113.0/24）而不是
 * 真实集群 IP——测试文件同样会随开源公开。
 */
const USER_CONFIG = {
  envs: {
    staging: {
      apiEndpoint: "tokenhub.staging.example.com",
      cloudApiInfix: "staging.",
      cloudApiHostIp: "203.0.113.10",
      chatHostPrefix: "staging-",
      routeByUserId: true,
      insecureTls: true,
    },
  },
};

/** 在隔离 HOME 下跑 CLI，可选写入一份用户配置 */
function run(args: string[], config?: unknown): string {
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(home, ".thcli", "config.json"),
      JSON.stringify(config, null, 2),
    );
  }
  try {
    return execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, THCLI_LANG: "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-env-test-"));
  fs.mkdirSync(path.join(home, ".thcli"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env["THCLI_ENV"];
  delete process.env["THCLI_USER_ID"];
  delete process.env["THCLI_API_ENDPOINT"];
});

describe("内置环境", () => {
  it("只内置 prod —— 其余环境是用户配置的事，不进仓库", () => {
    assert.deepEqual(allowedEnvs(), ["prod"]);
    assert.equal(DEFAULT_ENV, "prod");
  });

  it("prod 不换 endpoint、不加前缀、不带账号头", () => {
    const conf = envConfigOf("prod");
    // apiEndpoint 为 undefined 表示交给 SDK 用内置正式地址，而不是传空串
    assert.equal(conf.apiEndpoint, undefined);
    assert.equal(apiEndpointOf("prod"), undefined);
    assert.ok(!conf.chatHostPrefix);
    assert.ok(!conf.routeByUserId);
  });

  it("prod 的其它云产品 host 不带中缀", () => {
    assert.equal(cloudApiHostOf("prod", "cam"), "cam.tencentcloudapi.com");
    assert.equal(cloudApiHostOf("prod", "monitor"), "monitor.tencentcloudapi.com");
  });

  it("未知环境按缺省环境处理，不抛错", () => {
    assert.deepEqual(envConfigOf("nope"), envConfigOf(DEFAULT_ENV));
    assert.equal(cloudApiHostIpOf("nope"), undefined);
  });
});

describe("用户配置定义的环境", () => {
  it("config.json 里声明的环境会出现在 env list 里", () => {
    const out = run(["env", "list"], USER_CONFIG);
    assert.match(out, /prod/);
    assert.match(out, /staging/, `staging 未被加载：\n${out}`);
    assert.match(out, /tokenhub\.staging\.example\.com/);
  });

  it("没有 config.json 时只有 prod —— 这正是「测试环境突然连不上」的样子", () => {
    const out = run(["env", "list"]);
    assert.match(out, /prod/);
    assert.doesNotMatch(out, /staging/);
  });

  it("切到未声明的环境会被拒绝，并提示去 config.json 配", () => {
    const out = run(["env", "use", "--name", "staging"]);
    assert.match(out, /staging/);
    assert.match(out, /config\.json/, `缺少配置引导，用户只会看到"不支持的环境"：\n${out}`);
  });

  it("切过去之后各字段生效：endpoint / 云产品中缀", () => {
    // env current 显示的是**当前生效**环境，所以要先切过去，否则只会看到 prod
    run(["env", "use", "--name", "staging"], USER_CONFIG);
    const out = run(["env", "current"]);
    assert.match(out, /staging/, `未切到 staging：\n${out}`);
    assert.match(out, /tokenhub\.staging\.example\.com/, `apiEndpoint 未生效：\n${out}`);
    assert.match(out, /cam\.staging\./, `cloudApiInfix 未生效：\n${out}`);
  });

  it("deepMerge 是局部覆盖：只声明一个环境不会顶掉内置的 prod", () => {
    const out = run(["env", "list"], USER_CONFIG);
    assert.match(out, /prod/, `内置 prod 被用户配置顶掉了：\n${out}`);
  });
});

describe("数据面 host 的四地域 × 两环境矩阵", () => {
  // 主域由站点决定（tencentmaas / tencentcloudmaas）、-intl 由地域决定，两维独立
  // ——「国内广州」与「国际广州」是不同的 host，曾因 intl 照抄 cn 的值而全错。
  const MATRIX: Array<[string, string, string]> = [
    ["cn", "gz", "tokenhub.tencentmaas.com"],
    ["cn", "sg", "tokenhub-intl.tencentmaas.com"],
    ["intl", "gz", "tokenhub.tencentcloudmaas.com"],
    ["intl", "sg", "tokenhub-intl.tencentcloudmaas.com"],
  ];

  for (const [site, region, prod] of MATRIX) {
    it(`${site}/${region} 的 prod host`, () => {
      assert.equal(chatHostOf(site, region, "prod"), prod);
    });
  }

  it("两站的同名地域 host 不同（主域随站点变）", () => {
    assert.notEqual(chatHostOf("cn", "gz", "prod"), chatHostOf("intl", "gz", "prod"));
  });

  it("省略 env 参数时按 prod 处理", () => {
    assert.equal(chatHostOf("cn", "gz"), chatHostOf("cn", "gz", "prod"));
  });

  it("intl 只有 gz/sg 两个地域（ae 是未经验证的占位，已移除）", () => {
    assert.deepEqual(allowedRegions("intl"), ["gz", "sg"]);
  });
});

describe("env 的解析优先级", () => {
  it("环境变量 > settings.json / 缺省", () => {
    process.env["THCLI_ENV"] = "whatever";
    assert.equal(resolveEnv(), "whatever");
  });

  it("不收命令行参数——环境是会话级状态，避免单条命令跨环境用错凭证", () => {
    // 签名上就不接受参数，这里用类型层面的调用形式钉住：传参会编译不过
    assert.equal(resolveEnv.length, 0);
  });

  it("THCLI_API_ENDPOINT 能盖过环境自带的 endpoint", () => {
    process.env["THCLI_API_ENDPOINT"] = "custom.example.com";
    // 连 prod 也能被指走，便于临时打到别的网关排查
    assert.equal(apiEndpointOf("prod"), "custom.example.com");
    assert.equal(apiEndpointOf("nope"), "custom.example.com");
  });
});

describe("跳过 TLS 校验的边界", () => {
  // 这是安全不变量，不能因为"配置里写了"就放开：一旦生产也能跳过证书校验，
  // 中间人就能截获 access_token
  it("prod 永远不跳过", () => {
    assert.equal(insecureTlsOf("prod"), false);
  });

  it("未知环境按 prod 处理，也不跳过", () => {
    assert.equal(insecureTlsOf("nope"), false);
  });

  it("用户配置就算给 prod 写了 insecureTls 也无效", () => {
    // 用户配置能新增环境，但不能放开正式环境的证书校验——insecureTlsOf 对
    // DEFAULT_ENV 无条件返回 false，这条比配置优先级更硬
    const out = run(["env", "current"], { envs: { prod: { insecureTls: true } } });
    assert.doesNotMatch(out, /跳过 TLS|skips TLS/, `prod 的 TLS 校验被配置放开了：\n${out}`);
  });
});
