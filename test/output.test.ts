/**
 * --json 结构化输出的单元测试。
 *
 * 覆盖重点是「加了 --json 会不会伤到原有行为」和「密钥会不会漏出去」：
 *   - 非 JSON 模式必须零输出且返回 false（命令层靠这个返回值决定是否走原渲染，
 *     若它误返回 true，所有文本输出会集体消失）
 *   - 脱敏要递归（密钥常嵌在 ApiKeySet[] / ApiKeyInfo 里，只扫顶层等于没扫）
 *   - 输出必须是能被 JSON.parse 的纯文本（混进一行人话，调用方就全解析失败）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emitJson, emitJsonSafe, isJson, sanitize, setJsonMode } from "../src/core/output.js";

/** 抓住 console.log 输出，并保证测试结束后恢复 */
function capture(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("emitJson 的短路语义", () => {
  it("非 JSON 模式返回 false 且不产生任何输出", () => {
    setJsonMode(false);
    let result = true;
    const lines = capture(() => {
      result = emitJson({ a: 1 });
    });
    assert.equal(result, false);
    assert.deepEqual(lines, []);
  });

  it("JSON 模式返回 true 并输出可解析的 JSON", () => {
    setJsonMode(true);
    let result = false;
    const lines = capture(() => {
      result = emitJson({ ModelSet: [{ ModelId: "m1" }], TotalCount: 1 });
    });
    setJsonMode(false);
    assert.equal(result, true);
    // 整段输出必须是一个合法 JSON——命令层依赖这点，混入其它行就没法解析
    const parsed = JSON.parse(lines.join("\n")) as { TotalCount: number };
    assert.equal(parsed.TotalCount, 1);
  });

  it("isJson 与 setJsonMode 一致", () => {
    setJsonMode(true);
    assert.equal(isJson(), true);
    setJsonMode(false);
    assert.equal(isJson(), false);
  });
});

describe("密钥脱敏", () => {
  it("打码顶层的密钥字段", () => {
    const out = sanitize({ ApiKey: "sk-abcdefghijklmnop", Name: "test" }) as Record<string, string>;
    assert.equal(out["Name"], "test");
    assert.notEqual(out["ApiKey"], "sk-abcdefghijklmnop");
    assert.match(out["ApiKey"] as string, /\*{4}/);
  });

  it("递归打码数组里嵌套的密钥（key list 的真实形态）", () => {
    const out = sanitize({
      ApiKeySet: [
        { ApiKeyId: "k1", ApiKey: "sk-abcdefghijklmnop" },
        { ApiKeyId: "k2", ApiKey: "sk-qrstuvwxyz123456" },
      ],
      RequestId: "req-1",
    }) as { ApiKeySet: Array<Record<string, string>>; RequestId: string };
    assert.equal(out.RequestId, "req-1");
    for (const item of out.ApiKeySet) {
      assert.match(item["ApiKey"] as string, /\*{4}/);
    }
    // ID 不是密钥，不该被动
    assert.equal(out.ApiKeySet[0]?.["ApiKeyId"], "k1");
  });

  it("Secret / SecretId / SecretKey 同样打码", () => {
    const out = sanitize({
      Secret: "abcdefghijklmnop",
      SecretId: "AKIDabcdefghijkl",
      SecretKey: "zyxwvutsrqponmlk",
    }) as Record<string, string>;
    for (const key of ["Secret", "SecretId", "SecretKey"]) {
      assert.match(out[key] as string, /\*{4}/, `${key} 应被打码`);
    }
  });

  it("不改动原对象（调用方后续渲染仍要用原值）", () => {
    const input = { ApiKey: "sk-abcdefghijklmnop" };
    sanitize(input);
    assert.equal(input.ApiKey, "sk-abcdefghijklmnop");
  });

  it("null 与非对象原样返回，不抛错", () => {
    assert.equal(sanitize(null), null);
    assert.equal(sanitize(42), 42);
    assert.equal(sanitize("plain"), "plain");
  });

  it("emitJsonSafe 输出的 JSON 里不含明文", () => {
    setJsonMode(true);
    const lines = capture(() => {
      emitJsonSafe({ ApiKeySet: [{ ApiKey: "sk-abcdefghijklmnop" }] });
    });
    setJsonMode(false);
    const text = lines.join("\n");
    assert.ok(!text.includes("sk-abcdefghijklmnop"), "明文不应出现在 JSON 输出里");
    JSON.parse(text); // 仍须是合法 JSON
  });
});
