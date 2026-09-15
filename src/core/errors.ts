/**
 * tokenhub 高频错误码 → 原因 + 修复建议。
 *
 * 两处共用：doctor error（主动查）与顶层错误处理（命令报错时自动附上建议）。
 * 后者才是主战场——用户报错时当场看到怎么修，不用事后手查。
 *
 * 文案在 locales 里（键 `errcode.<码>.reason` / `.fix`，码里的点换成下划线），
 * 这里只留码清单。这样切英文时连原因与修复建议一起变，而不是只翻标签。
 */
import { t } from "./i18n.js";

/** 一条错误码释义 */
export interface ErrorInfo {
  reason: string;
  fix: string;
}

/** 管控面（云 API）错误码。顺序即 doctor error 的列出顺序 */
export const CLOUD_CODES: string[] = [
  "AuthFailure.SecretIdNotFound",
  "AuthFailure.SignatureFailure",
  "AuthFailure.TokenFailure",
  "AuthFailure.SecretIdMalformed",
  "UnauthorizedOperation",
  "RequestLimitExceeded",
  "ResourceNotFound",
  "ResourceNotFound.EndpointNotExist",
  "InvalidParameter",
  "LimitExceeded",
  "FailedOperation.RefreshTokenError",
  "UnsupportedRegion",
  "UnsupportedOperation",
];

/**
 * 数据面（网关）业务码。用户跑 +chat 撞到的是这一类，与 HTTP 状态码独立。
 *
 * 从服务端的错误码定义摘录而来，一次性拷入、不做自动同步——服务端加码时这里
 * 不会自动知道，`doctor error <码>` 会走"未收录"分支列出清单，不会给错答案。
 * 码段划分：400xxx 请求非法 / 401xxx 认证与额度 / 403xxx 权限与封禁 /
 * 410·413·429·451·499xxx 各类拒绝 / 5xxxxx 服务端。
 */
export const GATEWAY_CODES: string[] = [
  "400001",
  "400002",
  "400003",
  "400004",
  "400005",
  "400006",
  "401001",
  "401002",
  "401003",
  "401004",
  "401005",
  "401006",
  "401007",
  "401008",
  "401009",
  "401010",
  "403001",
  "403002",
  "403003",
  "403004",
  "403005",
  "403006",
  "410001",
  "413001",
  "429001",
  "429002",
  "429003",
  "429004",
  "429005",
  "429006",
  "451001",
  "499001",
  "500001",
  "502001",
  "503001",
  "504001",
];

/** 已收录的全部错误码 */
export const ERROR_CODES: string[] = [...CLOUD_CODES, ...GATEWAY_CODES];

/** 码 → locales 键前缀。点在键里会与层级分隔混淆，故换成下划线 */
function keyOf(code: string): string {
  return `errcode.${code.replace(/\./g, "_")}`;
}

/** 取一个码的释义；未收录返回 undefined */
function infoOf(code: string): ErrorInfo | undefined {
  if (!ERROR_CODES.includes(code)) {
    return undefined;
  }
  return { reason: t(`${keyOf(code)}.reason`), fix: t(`${keyOf(code)}.fix`) };
}

/** 按错误码查释义，支持前缀回退（如 AuthFailure.Xxx 未收录时退到 AuthFailure 的通用建议） */
export function lookupError(code: string): ErrorInfo | undefined {
  const direct = infoOf(code);
  if (direct) {
    return direct;
  }
  // 带命名空间的码，退到父命名空间找一个宽泛建议
  const dot = code.indexOf(".");
  if (dot > 0) {
    return infoOf(code.slice(0, dot));
  }
  return undefined;
}

/** 腾讯云 SDK 异常上带的 code 字段，官方类型未导出，此处按实际形态取 */
export function errorCodeOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
