/**
 * 全局设置与旧文件迁移测试。
 *
 * 迁移是一次性的、会删源文件的操作——出错就丢用户设置且不可回退，
 * 所以必须有测试。用临时 HOME 跑，避免动到真实 ~/.thcli。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";

const CLI = path.join(process.cwd(), "dist", "main.cjs");
let home: string;

/** 在隔离的 HOME 下跑 CLI */
function run(args: string[]): string {
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

function configDir(): string {
  return path.join(home, ".thcli");
}

function readSettings(): Record<string, string> {
  const file = path.join(configDir(), "settings.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-test-"));
  fs.mkdirSync(path.join(home, ".thcli"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("旧配置文件迁移", () => {
  it("三个旧文件的值都并入 settings.json 并删除源文件", () => {
    fs.writeFileSync(path.join(configDir(), "active_profile"), "myprofile\n");
    fs.writeFileSync(path.join(configDir(), "active_site"), "intl\n");
    fs.writeFileSync(path.join(configDir(), "lang"), "en\n");

    run(["lang"]);

    assert.deepEqual(readSettings(), { profile: "myprofile", site: "intl", lang: "en" });
    for (const legacy of ["active_profile", "active_site", "lang"]) {
      assert.equal(
        fs.existsSync(path.join(configDir(), legacy)),
        false,
        `${legacy} 应已删除——留着会让人困惑哪份生效`,
      );
    }
  });

  it("只有部分旧文件时也能迁", () => {
    fs.writeFileSync(path.join(configDir(), "lang"), "en\n");
    run(["lang"]);
    assert.deepEqual(readSettings(), { lang: "en" });
  });

  it("新设置优先于旧文件，不被残留覆盖回去", () => {
    // 用户已用新版设过 zh，同时目录里还留着旧的 lang=en
    fs.writeFileSync(
      path.join(configDir(), "settings.json"),
      `${JSON.stringify({ lang: "zh" })}\n`,
    );
    fs.writeFileSync(path.join(configDir(), "lang"), "en\n");

    run(["lang"]);

    assert.equal(readSettings()["lang"], "zh", "新值应保留");
  });

  it("旧文件内容为空时跳过，且不为此凭空建 settings.json", () => {
    fs.writeFileSync(path.join(configDir(), "lang"), "\n");
    run(["lang"]);
    // 没有任何设置要存时不该创建文件——空文件只会让人以为设过
    assert.equal(
      fs.existsSync(path.join(configDir(), "settings.json")),
      false,
      "无有效设置时不应创建 settings.json",
    );
  });

  it("旧文件为空时仍会被清理掉", () => {
    const legacy = path.join(configDir(), "lang");
    fs.writeFileSync(legacy, "\n");
    run(["lang"]);
    // 空的旧文件也该删：留着它下次启动还要再读一遍
    assert.equal(fs.existsSync(legacy), false, "空旧文件也应清理");
  });

  it("settings.json 损坏时按空处理，不让命令挂掉", () => {
    fs.writeFileSync(path.join(configDir(), "settings.json"), "{ not json");
    const out = run(["lang"]);
    assert.ok(out.includes("zh") || out.includes("中文"), `命令应仍可用：${out}`);
  });
});

describe("设置的读写", () => {
  it("lang set 写入 settings.json", () => {
    run(["lang", "set", "en"]);
    assert.equal(readSettings()["lang"], "en");
  });

  it("thcli lang <code> 是 lang set 的简写", () => {
    // 曾经 `thcli lang en` 被当成未知子命令，静默落到 current 并显示旧值
    run(["lang", "en"]);
    assert.equal(readSettings()["lang"], "en", "简写形式应真正写入");
  });

  it("site use 与 profile use 写入同一份文件，互不覆盖", () => {
    run(["site", "use", "--name", "intl"]);
    run(["lang", "set", "en"]);
    const settings = readSettings();
    assert.equal(settings["site"], "intl");
    assert.equal(settings["lang"], "en", "写 lang 不应擦掉 site");
  });

  it("site use --clear 只清 site，保留其它项", () => {
    run(["site", "use", "--name", "intl"]);
    run(["lang", "set", "en"]);
    run(["site", "use", "--clear"]);
    const settings = readSettings();
    assert.equal(settings["site"], undefined);
    assert.equal(settings["lang"], "en", "清 site 不应带走 lang");
  });
});
