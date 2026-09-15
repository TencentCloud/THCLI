/**
 * +connect：把从远端 COS 下载的 Agent Skills 注入本地 Agent 的 skills 目录，
 * 让 Agent 能用自然语言驱动 thcli。
 *
 * 0.2.0 起 skills 不再随 npm 包分发，改为按需从远端 COS 下载。只暴露三个入口：
 *   thcli +connect           → 下载到 ~/.thcli/skills-cache/ 并注入 Agent（装机 = 更新）
 *   thcli +connect status    → 本地版本、远端版本、缓存内容、已注入的 Agent
 *   thcli +connect uninstall → 移除已注入的 skills
 *
 * 不拆出独立的 refresh / skills 子命令：下载与注入分离对用户没有意义，而"记不清
 * 该跑哪个"本身就是负担。裸命令幂等，远端无变化时只打印一行、不重复拷文件。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

import { emitJson, isJson } from "../core/output.js";
import { t } from "../core/i18n.js";
import { SKILLS_CACHE_DIR } from "../core/paths.js";
import {
  diffManifest,
  fetchLatestIndex,
  fetchRemoteManifest,
  readLocalManifest,
  refreshSkills,
} from "../core/skills-manifest.js";
import { resolveSkillsSource } from "../core/skills-source.js";

/** 内置 skill 目录的统一前缀，卸载时据此识别 */
const PREFIX = "thcli-";

/**
 * 已知 Agent → 默认 skills 目录；表外的用 --target 兜底。
 *
 * 命名与路径均按各家 2026-09 官方文档：
 *   - Codex CLI 走的是社区共享标准 ~/.agents/skills（不是 ~/.codex/skills）
 *   - Trae 官方目录带 -cn 后缀 ~/.trae-cn/skills
 *   - Cursor / Roo Code / Kilo Code / OpenClaw 也会读 ~/.agents/skills，
 *     但各自专属目录默认被扫，用专属目录更保险
 *
 * resolveTargets 只对"目录已存在或父目录已存在"的项做安装，用户没装的 Agent
 * 自然被跳过，全量列表并不会造成误注入。
 */
const AGENT_TARGETS: Record<string, string> = {
  "claude-code":    path.join(os.homedir(), ".claude",    "skills"),
  "codebuddy-code": path.join(os.homedir(), ".codebuddy", "skills"),
  "cline":          path.join(os.homedir(), ".cline",     "skills"),
  "codex":          path.join(os.homedir(), ".agents",    "skills"),
  "cursor":         path.join(os.homedir(), ".cursor",    "skills"),
  "kilo-code":      path.join(os.homedir(), ".kilo",      "skills"),
  "openclaw":       path.join(os.homedir(), ".openclaw",  "skills"),
  "roo-code":       path.join(os.homedir(), ".roo",       "skills"),
  "trae":           path.join(os.homedir(), ".trae-cn",   "skills"),
};

/** 列出本地缓存里现有的 skill 目录名 */
function cachedSkills(): string[] {
  try {
    return fs
      .readdirSync(SKILLS_CACHE_DIR)
      .filter(
        (d) =>
          d.startsWith(PREFIX) &&
          fs.statSync(path.join(SKILLS_CACHE_DIR, d)).isDirectory(),
      );
  } catch {
    return [];
  }
}

/** 解析目标目录：--target 优先，否则列出所有探测到的 Agent */
function resolveTargets(target?: string): Array<[string, string]> {
  if (target) {
    const expanded = target.startsWith("~")
      ? path.join(os.homedir(), target.slice(1))
      : target;
    return [["(--target)", expanded]];
  }
  return Object.entries(AGENT_TARGETS).filter(
    ([, dir]) => fs.existsSync(dir) || fs.existsSync(path.dirname(dir)),
  );
}

function install(targets: Array<[string, string]>, skills: string[]): void {
  for (const [label, dir] of targets) {
    fs.mkdirSync(dir, { recursive: true });
    for (const skill of skills) {
      const dst = path.join(dir, skill);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(path.join(SKILLS_CACHE_DIR, skill), dst, { recursive: true });
    }
    console.log(
      t("connect.installed", {
        label,
        dir,
        count: skills.length,
        names: skills.join(", "),
      }),
    );
  }
  console.log(t("connect.doneHint"));
}

function uninstall(targets: Array<[string, string]>): void {
  for (const [label, dir] of targets) {
    let removed: string[] = [];
    try {
      removed = fs.readdirSync(dir).filter((d) => d.startsWith(PREFIX));
    } catch {
      continue;
    }
    for (const name of removed) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    console.log(
      t("connect.removed", {
        label,
        dir,
        count: removed.length,
        names: removed.join(", ") || t("common.none"),
      }),
    );
  }
}

/** 注入 skills 到本地 Agent */
function installSkills(target?: string): void {
  const skills = cachedSkills();
  if (!skills.length) {
    // 缓存为空——严格提示先 refresh（对齐"由用户显式调用"原则）
    console.log(t("connect.skills.emptyCache"));
    return;
  }
  const targets = resolveTargets(target);
  if (!targets.length) {
    console.log(t("connect.noAgent"));
    console.log(t("connect.noAgentManual"));
    return;
  }
  install(targets, skills);
}

/** 移除已注入的 thcli skills */
function uninstallSkills(target?: string): void {
  const targets = resolveTargets(target);
  if (!targets.length) {
    console.log(t("connect.noAgentPlain"));
    return;
  }
  uninstall(targets);
}

/**
 * 找出「已注入过 thcli skills」的 Agent 目标（该目录里存在 thcli-* 子目录）。
 * refresh 完成后据此自动同步——避免用户 refresh 完 Agent 侧还在用旧版。
 */
function detectInjectedTargets(): Array<[string, string]> {
  return Object.entries(AGENT_TARGETS).filter(([, dir]) => {
    try {
      return fs.readdirSync(dir).some((d) => d.startsWith(PREFIX));
    } catch {
      return false;
    }
  });
}

/** 从远端 COS 下载/更新 skills 到本地缓存 */
async function refreshCommand(): Promise<void> {
  const source = resolveSkillsSource();
  console.log(t("connect.refresh.source", { url: source.latestUrl }));

  const local = readLocalManifest();
  let refreshedOk = false;
  let changed = false;
  try {
    const result = await refreshSkills({
      latestUrl: source.latestUrl,
      onProgress: (msg) => console.log(`  ${msg}`),
    });

    // 无变化时只说一句，不再打印"下载 0、跳过 18、新增 0…"那种全零简报——
    // 重复执行是常态（裸 +connect 既装机也更新），啰嗦的输出会淹没真正有变化的那次
    if (result.downloaded === 0) {
      console.log(t("connect.refresh.upToDate", { version: result.version }));
    } else {
      const remote = readLocalManifest(); // 已写入本地
      const diff = diffManifest(local, remote || { version: "", publishedAt: "", skills: [] });
      console.log(
        t("connect.refresh.done", {
          version: result.version,
          downloaded: result.downloaded,
          skipped: result.skipped,
          added: diff.added.length,
          changed: diff.changed.length,
          removed: diff.removed.length,
        }),
      );
    }
    changed = result.downloaded > 0;
    refreshedOk = true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(t("connect.refresh.failed", { reason }));
    process.exit(1);
  }

  // 自动同步：已注入的 Agent 跟着更新，保持它和本地缓存一致。
  // 缓存无变化时跳过——重新拷一遍同样的文件没有意义，只会让每次执行都刷一屏
  if (refreshedOk && changed) {
    const injected = detectInjectedTargets();
    if (injected.length) {
      console.log(t("connect.refresh.autoSync", { count: injected.length }));
      const skills = cachedSkills();
      if (skills.length) {
        install(injected, skills);
      }
    }
  }
}

/** 查看本地缓存与远端版本状态 */
async function statusCommand(): Promise<void> {
  const source = resolveSkillsSource();
  const local = readLocalManifest();

  // JSON 模式走独立路径：文本模式把结论分散在整个流程里逐行打印，
  // 那种交错的输出没法在中途插一个 emitJson 就变成合法 JSON。
  if (isJson()) {
    let remoteVersion: string | null = null;
    let remoteError: string | null = null;
    let contentDiff: { added: number; changed: number; removed: number } | null = null;
    try {
      const latest = await fetchLatestIndex(source.latestUrl);
      remoteVersion = latest.version;
      if (local && local.version === latest.version) {
        const diff = diffManifest(local, await fetchRemoteManifest(latest.baseUrl));
        contentDiff = {
          added: diff.added.length,
          changed: diff.changed.length,
          removed: diff.removed.length,
        };
      }
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err);
    }
    emitJson({
      LocalVersion: local?.version ?? null,
      LocalPublishedAt: local?.publishedAt || null,
      RemoteVersion: remoteVersion,
      RemoteError: remoteError,
      ContentDiff: contentDiff,
      CachedSkills: cachedSkills(),
      InjectedTargets: detectInjectedTargets().map(([label, dir]) => ({ Agent: label, Dir: dir })),
    });
    return;
  }

  if (local) {
    console.log(
      t("connect.status.local", {
        version: local.version,
        publishedAt: local.publishedAt || "-",
      }),
    );
  } else {
    console.log(t("connect.status.noCache"));
  }

  // 探测远端（失败不阻塞——用户能拿到本地信息也算有价值）
  try {
    const latest = await fetchLatestIndex(source.latestUrl);
    console.log(t("connect.status.remote", { version: latest.version }));

    if (local && local.version === latest.version) {
      // 版本号一样但 sha256 可能不同（懒版本模式下允许覆盖 current/），加一步内容比对
      const remoteManifest = await fetchRemoteManifest(latest.baseUrl);
      const diff = diffManifest(local, remoteManifest);
      if (diff.added.length + diff.changed.length + diff.removed.length === 0) {
        console.log(t("connect.status.upToDate"));
      } else {
        console.log(
          t("connect.status.contentChanged", {
            added: diff.added.length,
            changed: diff.changed.length,
            removed: diff.removed.length,
          }),
        );
      }
    } else if (!local || local.version !== latest.version) {
      console.log(t("connect.status.updateAvailable"));
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(t("connect.status.remoteUnavailable", { reason }));
  }

  // 版本号之外，用户还想知道"缓存里有哪些 skill、装到哪个 Agent 了"——
  // 这两件事以前在独立的 list 子命令里，合过来省掉一个命令
  const skills = cachedSkills();
  if (skills.length) {
    console.log(t("connect.cached", { count: skills.length, names: skills.join(", ") }));
  }

  const injected = detectInjectedTargets();
  if (injected.length) {
    console.log(t("connect.injectedHeader"));
    for (const [label, dir] of injected) {
      console.log(`  ${label}  ${dir}`);
    }
  } else {
    const targets = resolveTargets(undefined);
    console.log(targets.length ? t("connect.notInjected") : t("connect.noAgentHint"));
  }
}

/** 装配 +connect */
export function registerConnectCommands(program: Command): void {
  const connect = program.command("+connect").description(t("group.connect.desc"));

  connect
    .command("status")
    .description(t("connect.status.desc"))
    .action(async () => {
      await statusCommand();
    });

  connect
    .command("uninstall")
    .description(t("connect.uninstall.desc"))
    .option("--target <dir>", t("connect.uninstall.opt.target"))
    .action((opts: { target?: string }) => uninstallSkills(opts.target));

  // 裸 +connect 一键装机：下载到本地缓存 + 注入到 Agent。
  //
  // 只暴露这一个入口，不再单独提供 refresh / skills 子命令——那两步的分离对用户
  // 没有意义（谁下载了却不想注入？），而"记不清该跑哪个"本身就是负担。
  // 需要指定非内置 Agent 目录时用 --target。
  // 未知子命令要报错，不能被裸 action 静默吃掉：`+connect refresh`（已移除的旧命令）
  // 会让人以为它还在工作，而实际执行的是裸命令，输出还看不出区别
  connect.argument("[unknown...]", t("connect.arg.unknown"));

  connect
    .option("--target <dir>", t("connect.opt.target"))
    .action(async (unknown: string[], opts: { target?: string }) => {
      if (unknown.length) {
        console.error(t("connect.unknownSub", { name: unknown[0] ?? "" }));
        process.exit(2);
      }
      // 先下载。网络失败时 refreshCommand 会自己 exit(1)
      await refreshCommand();
      // refresh 内部只会同步"已注入过"的 Agent；首次装机没注入过，这里补一次
      if (!detectInjectedTargets().length) {
        installSkills(opts.target);
      }
    });
}
