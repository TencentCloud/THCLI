/**
 * ~/.thcli 下各配置文件的路径约定，集中一处避免各命令自行拼接。
 */
import os from "node:os";
import path from "node:path";

/** thcli 的配置根目录 */
export const CONFIG_DIR = path.join(os.homedir(), ".thcli");

/** 管控凭证文件：按 profile + site 分开存，避免国内/国际站互相覆盖 */
export function credentialPath(profile: string, site: string): string {
  return path.join(CONFIG_DIR, `${profile}.${site}.credential`);
}

/** 数据面 API Key 存储：按 profile 一个文件，内部再按 site/region/type/alias 分层 */
export function dataConfigPath(profile: string): string {
  return path.join(CONFIG_DIR, `${profile}.tokenhub.json`);
}

/**
 * per-profile 的杂项配置（当前只有默认地域 region）。区别于凭证/数据面 key，
 * 存的是"这个 profile 的其他配置"，未来可扩展。profile set --region 写入。
 */
export function configurePath(profile: string): string {
  return path.join(CONFIG_DIR, `${profile}.configure`);
}

/** 用户对内置 infra 配置的覆盖文件 */
export const USER_CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

/** 调用日志目录 */
export const LOG_DIR = path.join(CONFIG_DIR, "log");

/**
 * Agent Skills 本地缓存目录。skills 不再随 npm 包分发，改为从远端 COS 显式下载
 * 到此目录，供 +connect 注入本地 Agent。目录结构与远端版本目录同构：
 *   ~/.thcli/skills-cache/
 *   ├── manifest.json         下载记录（版本、时间、每文件 sha256）
 *   ├── thcli-shared/SKILL.md
 *   └── ...
 */
export const SKILLS_CACHE_DIR = path.join(CONFIG_DIR, "skills-cache");

/** 缓存版的 manifest.json 路径 */
export const SKILLS_MANIFEST_PATH = path.join(SKILLS_CACHE_DIR, "manifest.json");

/**
 * 日志文件：管控面（console）与数据面（chat）分开，便于排查时只看一侧。
 */
export function logPath(profile: string, site: string, kind: "console" | "chat"): string {
  return path.join(LOG_DIR, `${profile}.${site}.tokenhub-plugin-${kind}.log`);
}
