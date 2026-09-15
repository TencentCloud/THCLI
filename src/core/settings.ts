/**
 * CLI 全局设置：~/.thcli/settings.json。
 *
 * 合并了原先三个单值文本文件（active_profile / active_site / lang）——它们都是
 * "CLI 级、单值、纯文本"，各占一个文件让 ~/.thcli 越来越杂，也没法一眼看全当前状态。
 *
 * 与另两份配置的分工：
 *   settings.json        本文件。当前 profile / 站点 / 界面语言，由 use/set 命令写
 *   config.json          基础设施覆盖（站点域名、鉴权后端），手工编辑，见 core/config.ts
 *   {profile}.configure  per-profile 的配置（地域、默认 Key），随 profile 隔离
 *
 * 旧文件仍会被读取一次并自动迁移（见 migrateLegacyFiles），迁完即删，
 * 老用户升级后不会丢设置。
 */
import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "./paths.js";

/** 设置文件路径 */
export const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

/** 全局设置的形状。都是可选——缺哪项就用各自的默认值 */
export interface Settings {
  /** 当前 profile，profile use 写入 */
  profile?: string;
  /** 当前站点，site use 写入 */
  site?: string;
  /** 界面语言，lang set 写入 */
  lang?: string;
  /** 当前环境，env use 写入。缺省 prod */
  env?: string;
}

/** 旧的单值文件 → 设置字段。仅用于一次性迁移 */
const LEGACY_FILES: Array<{ file: string; key: keyof Settings }> = [
  { file: "active_profile", key: "profile" },
  { file: "active_site", key: "site" },
  { file: "lang", key: "lang" },
];

let cache: Settings | undefined;

function readTrimmed(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把旧的三个单值文件并进 settings.json，成功后删掉旧文件。
 *
 * 只在 settings.json 尚无对应字段时才采纳旧值——若用户已经用新版设置过，
 * 新值优先，不能被残留的旧文件覆盖回去。
 */
function migrateLegacyFiles(current: Settings): { merged: Settings; changed: boolean } {
  let changed = false;
  const merged = { ...current };
  for (const { file, key } of LEGACY_FILES) {
    const full = path.join(CONFIG_DIR, file);
    if (!fs.existsSync(full)) {
      continue;
    }
    const value = readTrimmed(full);
    // 空文件不产生设置，但仍要删——否则它会永久残留，每次启动都白读一遍
    if (value !== undefined && merged[key] === undefined) {
      merged[key] = value;
      changed = true;
    }
    try {
      fs.unlinkSync(full);
    } catch {
      // 删不掉不影响功能，下次启动再试
    }
  }
  return { merged, changed };
}

/** 读全局设置，进程内缓存。首次读取时顺带迁移旧文件 */
export function loadSettings(): Settings {
  if (cache) {
    return cache;
  }
  let settings: Settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    // 文件不存在或损坏都按空处理，不让配置问题挡住所有命令
  }
  const { merged, changed } = migrateLegacyFiles(settings);
  if (changed) {
    writeSettings(merged);
  }
  cache = merged;
  return cache;
}

/** 整份写回，并刷新缓存 */
function writeSettings(settings: Settings): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  cache = settings;
}

/** 改一项设置，其余保持不动 */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  writeSettings({ ...loadSettings(), [key]: value });
}

/** 清掉一项设置（回落到默认值） */
export function clearSetting(key: keyof Settings): void {
  const next = { ...loadSettings() };
  delete next[key];
  writeSettings(next);
}

/** 读一项设置 */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return loadSettings()[key];
}
