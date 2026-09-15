/**
 * 数据面 API Key 的本地存储（与管控凭证物理隔离）。
 *
 * 结构：{ sites: { [site]: { [region]: { [type]: { [alias]: key } } } } }
 * type 为 th（普通版）/ tp-ep（企业版）/ tp（个人版）；同一 type 下可存多把 key，
 * 用 alias 区分（缺省 default）。文件权限 0600。
 */
import fs from "node:fs";
import { t } from "./i18n.js";

import { CONFIG_DIR, dataConfigPath } from "./paths.js";

/** key 类别 */
export type KeyType = "th" | "tp-ep" | "tp";

/** 合法的 key 类别 */
export const KEY_TYPES: KeyType[] = ["th", "tp-ep", "tp"];

/** 缺省 alias */
export const DEFAULT_ALIAS = "default";

/**
 * 一个 type 下的内容。正常是 {alias: key}；早期版本曾直接存裸字符串，
 * 读取时按 alias=default 兼容，避免升级后旧配置读不出来。
 */
type TypeSlot = Record<string, string> | string;

/** 数据面 key 配置 */
export interface DataConfig {
  sites?: Record<string, Record<string, Record<string, TypeSlot>>>;
}

/** 读配置；文件不存在返回空配置，内容损坏则抛错（不静默吞掉，避免误判"没配过"） */
export function loadDataConfig(profile: string): DataConfig {
  const path = dataConfigPath(profile);
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as DataConfig;
  } catch (err) {
    throw new Error(t("keystore.corrupt", { path, message: (err as Error).message }));
  }
}

/** 写配置，权限 0600 */
export function saveDataConfig(profile: string, cfg: DataConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const path = dataConfigPath(profile);
  fs.writeFileSync(path, `${JSON.stringify(cfg, null, 4)}\n`, { mode: 0o600 });
  // 文件已存在时 writeFileSync 的 mode 不生效，显式再设一次
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    // 某些文件系统不支持 chmod，不影响功能
  }
}

/** 把一个 type 槽位统一成 {alias: key} 形式，顺带兼容裸字符串的旧格式 */
function normalizeSlot(slot: TypeSlot | undefined): Record<string, string> {
  if (!slot) {
    return {};
  }
  if (typeof slot === "string") {
    return { [DEFAULT_ALIAS]: slot };
  }
  return slot;
}

/** 取某个 site/region/type/alias 下的 key */
export function resolveRegionKey(
  cfg: DataConfig,
  site: string,
  region: string,
  type: string,
  alias?: string,
): string | undefined {
  const slot = cfg.sites?.[site]?.[region]?.[type];
  return normalizeSlot(slot)[alias || DEFAULT_ALIAS];
}

/** 写入 key，就地修改并返回 cfg */
export function setRegionKey(
  cfg: DataConfig,
  site: string,
  region: string,
  type: string,
  value: string,
  alias?: string,
): DataConfig {
  cfg.sites ??= {};
  cfg.sites[site] ??= {};
  const siteEntry = cfg.sites[site];
  siteEntry[region] ??= {};
  const regionEntry = siteEntry[region];
  // 旧格式（裸字符串）先归一化，避免写入时把已有的 default 丢掉
  regionEntry[type] = normalizeSlot(regionEntry[type]);
  (regionEntry[type] as Record<string, string>)[alias || DEFAULT_ALIAS] = value;
  return cfg;
}

/** 列出某个 type 下的全部 alias */
export function listRegionKeyAliases(
  cfg: DataConfig,
  site: string,
  region: string,
  type: string,
): Record<string, string> {
  return normalizeSlot(cfg.sites?.[site]?.[region]?.[type]);
}
