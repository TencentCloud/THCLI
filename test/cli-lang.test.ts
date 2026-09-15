/**
 * 端到端语言测试：直接跑 CLI 进程，检查输出语言。
 *
 * 为什么要端到端而不是单测 t()：语言 bug 全出在**求值时机**上，单测 t() 永远是对的。
 * 已经踩过两次：
 *   1. initLang 放在注册命令之后 → 子命令 help 用默认语言
 *   2. initLang 放在 program 选项定义之后 → 全局 help 用默认语言
 * 两次都是「t() 本身没问题，但调用它的时候语言还没定」。只有跑真实进程能发现。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

const CLI = path.join(process.cwd(), "dist", "main.cjs");
const CJK = /[一-鿿]/;

/**
 * `lang` 命令组的描述刻意中英并排（`界面语言 / Interface language`），
 * 好让只读英文的用户在满屏中文里也能找到切语言的入口。检查英文输出时要放过它，
 * 否则这条设计会被测试逼掉。
 */
const BILINGUAL_BY_DESIGN = [
  /界面语言 \/ Interface language/,
  /显示当前语言 \/ Show current/,
  /列出可选语言 \/ List available/,
  /设置并保存语言 \/ Set and save/,
  /给了就直接设置 \/ set directly if given/,
];

/** 去掉刻意双语的行后再查中文残留 */
function stripBilingual(text: string): string {
  return text
    .split("\n")
    .filter((line) => !BILINGUAL_BY_DESIGN.some((re) => re.test(line)))
    .join("\n");
}

/** 跑一次 CLI，返回 stdout+stderr。语言只由 env/argv 控制，避免读到本机 ~/.thcli/lang */
function run(args: string[], lang?: string): string {
  const env = { ...process.env, THCLI_LANG: lang ?? "" };
  try {
    return execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (err) {
    // 非零退出也要拿输出（如 --help 之外的报错路径）
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/**
 * 从 `--help` 的 Commands 段抓出子命令名。
 * 形如 `  monitor             服务健康度：...` 或 `  deploy [options]    ...`，
 * 取首个词即命令名；`help` 是 commander 自带的，不必测。
 */
function childCommands(parent: string[]): string[] {
  const out = run([...parent, "--help"], "zh");
  const section = out.split(/^Commands:$/m)[1];
  if (!section) {
    return [];
  }
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const name = /^ {2}(\S+)/.exec(line)?.[1];
    if (name !== undefined && name !== "help") {
      names.push(name);
    }
  }
  return names;
}

/** 广度遍历整棵命令树，返回空串（根）加所有子命令路径 */
function enumerateCommands(): string[] {
  const all: string[] = [""];
  let frontier: string[][] = [[]];
  // 目前最深是三层（如 plan key list），留一层余量即可，避免遍历失控
  for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
    const next: string[][] = [];
    for (const parent of frontier) {
      for (const name of childCommands(parent)) {
        const full = [...parent, name];
        all.push(full.join(" "));
        next.push(full);
      }
    }
    frontier = next;
  }
  return all;
}

describe("CLI 输出语言", () => {
  it("全局 help 跟随 THCLI_LANG", () => {
    // 这条曾失败：program 的选项在模块顶层求值，早于 initLang
    const en = stripBilingual(run(["--help"], "en"));
    assert.ok(!CJK.test(en), `英文 help 里夹了中文：\n${en}`);

    const zh = run(["--help"], "zh");
    assert.ok(CJK.test(zh), "中文 help 应含中文");
  });

  it("子命令 help 跟随 THCLI_LANG", () => {
    // 这条也曾失败：initLang 放在 registerXxx 之后
    const en = run(["models", "free", "--help"], "en");
    assert.ok(!CJK.test(en), `英文子命令 help 里夹了中文：\n${en}`);
  });

  it("--lang 与环境变量等效", () => {
    const viaFlag = stripBilingual(run(["--help", "--lang", "en"], ""));
    assert.ok(!CJK.test(viaFlag), `--lang en 未生效：\n${viaFlag}`);
  });

  it("--lang 优先于环境变量", () => {
    const out = stripBilingual(run(["--help", "--lang", "en"], "zh"));
    assert.ok(!CJK.test(out), "--lang 应压过 THCLI_LANG");
  });

  it("banner 跟随语言", () => {
    const en = run([], "en");
    assert.ok(en.includes("Quick start"), `英文 banner 异常：\n${en}`);
    assert.ok(!CJK.test(en), `英文 banner 里夹了中文：\n${en}`);
  });

  it("错误码释义跟随语言（不只是标签）", () => {
    // 曾经只有 Code:/Reason:/Fix: 三个标签被翻译，内容仍是中文
    const en = run(["doctor", "error", "ResourceNotFound"], "en");
    assert.ok(!CJK.test(en), `英文错误释义里夹了中文：\n${en}`);
  });

  it("doctor error 清单跟随语言", () => {
    const en = run(["doctor", "error"], "en");
    assert.ok(!CJK.test(en), `英文错误清单里夹了中文：\n${en}`);
  });

  it("全部命令的 help 都无中文残留（英文模式）", () => {
    // 命令树从 help 递归枚举，不写死清单——写死的话新增命令默认不被覆盖，
    // 漏译也不会红。实测踩过：monitor audio / models compare 加完后清单没跟着改
    const commands = enumerateCommands();
    assert.ok(commands.length > 80, `命令枚举异常，只找到 ${commands.length} 个`);
    const offenders: string[] = [];
    for (const cmd of commands) {
      const args = cmd ? [...cmd.split(" "), "--help"] : ["--help"];
      const out = stripBilingual(run(args, "en"));
      const lines = out.split("\n").filter((l) => CJK.test(l));
      if (lines.length) {
        offenders.push(`thcli ${cmd || "(root)"}: ${lines[0]!.trim()}`);
      }
    }
    assert.deepEqual(offenders, [], `这些 help 仍含中文：\n${offenders.join("\n")}`);
  });

  it("lang 命令自身双语可用", () => {
    const out = run(["lang", "list"], "en");
    assert.ok(out.includes("zh") && out.includes("en"), `lang list 输出异常：\n${out}`);
  });
});
