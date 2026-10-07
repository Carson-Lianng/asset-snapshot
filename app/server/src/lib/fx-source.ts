/**
 * fx-source.ts —— 从**公开汇率源**取一次汇率（第三批 #1 / #2）
 *
 * 这个文件的存在本身是一个产品决策的落地：PRD §14 原本把「自动汇率」列为范围外
 * （理由是「存量盘点不需要实时行情，手动维护成本可接受」）。2026-10-04 用户把
 * 两条 P1 需求提出来之后，PRD §14 改成「支持从公开源**手动**刷新」——
 * 注意是手动：没有任何定时器、不在启动时偷偷请求。
 *
 * ── 五条硬约束（写在这里，因为每一条都能让这个功能变成风险）──
 *
 * 1. **源是白名单，URL 由代码拼**。绝不接受「请求参数里带 URL」这种设计 ——
 *    那等于给本机服务开了一个 SSRF 入口（能读内网、能读云元数据）。
 *    源只能通过环境变量 `FX_SOURCE` 选，且只认下面 `ENDPOINTS` 里的几个名字。
 *
 * 2. **只写默认汇率表，绝不回写历史快照**。口径约定 3：快照的冻结汇率不可变。
 *    本模块只负责「取数」，落库由调用方（catalog.ts 的 /rates/refresh）做，
 *    那里调的是 `putRates`（默认汇率表）这一条路径。
 *
 * 3. **失败必须降级成「保持原值」**，尤其是**绝不能把汇率清成 0**：
 *    汇率 0 会让盘点的「缺汇率门禁」把整张快照拦下来，用户看到的是
 *    「盘点做不下去了」，而真正的原因只是一个外部 API 抖了一下。
 *    所以本模块只 throw，不产出任何「部分/空」的表；调用方据此不写库。
 *
 * 4. **文档里说的方向要与代码一致**。源给的是「1 基准币 = R 目标币」，
 *    取倒数在 `@app/domain` 的 `ratesFromSource()` 里做（那是纯函数，有断言）。
 *    本模块只负责把源的 JSON 读成 `FxSourceTable`，**不碰方向**。
 *
 * 5. **有时限**。默认 8s 硬超时 —— 没有超时的话，一个不响应的源会把
 *    HTTP 请求挂到用户以为界面卡死。
 */
import type { FxSourceTable } from '@app/domain';

export type FxSource = 'frankfurter' | 'er-api' | 'off';

/**
 * 「真的能取数的源」—— 成功响应的 `source` 只可能是这两个。
 *
 * 把它单独命名不是洁癖：`FxFetchOutcome.source` 用它之后，「成功的刷新里不会出现
 * `off`」这件事就成了类型层面的事实，而不再靠「调用方记得先判一次」。
 * 契约侧的 `FxSourceName` 与它一一对应。
 */
export type FxActiveSource = Exclude<FxSource, 'off'>;

export const FX_SOURCES: readonly FxSource[] = ['frankfurter', 'er-api', 'off'];

/** 环境变量 → 白名单内的取值。非法值直接抛（与 env.ts 的「启动即失败」同风格） */
export function parseFxSource(raw: string | undefined): FxSource {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return 'frankfurter';
  if ((FX_SOURCES as readonly string[]).includes(v)) return v as FxSource;
  throw new Error(`环境变量 FX_SOURCE 只允许 ${FX_SOURCES.join(' / ')}，实际为 ${raw}`);
}

interface Endpoint {
  /** 界面上要显示的源名（用户需要知道这个数字是谁给的） */
  label: string;
  url(base: string): string;
  /** 源响应 → `1 base = R code` 的表；不合法就抛（由调用方转成可读错误） */
  read(payload: unknown): FxSourceTable;
}

function badShape(label: string, why: string): never {
  throw new Error(`${label} 的响应不符合预期：${why}`);
}

/** 校验一个「代码 → 正数」的表；顺带挡掉字符串数字与 null */
function ratesOf(raw: unknown, label: string): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) badShape(label, 'rates 不是对象');
  const out: Record<string, number> = {};
  for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    out[code.toUpperCase()] = v;
  }
  if (!Object.keys(out).length) badShape(label, 'rates 里没有任何可用的正数');
  return out;
}

/**
 * 白名单。加一个源 = 在这里加一项 + 在 `FX_SOURCES` 里加名字，
 * **不引入任何「由外部决定请求哪个地址」的通道**。
 */
const ENDPOINTS: Record<FxActiveSource, Endpoint> = {
  frankfurter: {
    label: 'Frankfurter（欧洲央行参考汇率）',
    /* 2026-10-04 实测：老域名 `api.frankfurter.app` 会 301 到 `api.frankfurter.dev/v1/latest`。
       `fetch` 默认跟随重定向，所以写老域名「也能用」—— 但那等于把一个已迁移的地址
       留在代码里等着它某天下线。这里直接写规范地址，少一跳，也不依赖重定向的寿命。
       响应形状两代相同：`{ amount, base, date, rates }`。 */
    url: base => `https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(base)}`,
    read: payload => {
      const p = payload as { base?: unknown; rates?: unknown };
      if (typeof p?.base !== 'string') badShape('Frankfurter', '缺少 base 字段');
      return { base: p.base.toUpperCase(), rates: ratesOf(p.rates, 'Frankfurter') };
    }
  },
  'er-api': {
    label: 'open.er-api.com（ExchangeRate-API 开放端点）',
    url: base => `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
    read: payload => {
      const p = payload as { result?: unknown; base_code?: unknown; rates?: unknown; 'error-type'?: unknown };
      if (p?.result !== 'success') {
        badShape('open.er-api.com', `result=${String(p?.result)}（error-type=${String(p?.['error-type'])})`);
      }
      if (typeof p.base_code !== 'string') badShape('open.er-api.com', '缺少 base_code 字段');
      return { base: p.base_code.toUpperCase(), rates: ratesOf(p.rates, 'open.er-api.com') };
    }
  }
};

/** 源不可用时的统一错误类型 —— 调用方只需把它转成 4xx/5xx，不必分辨细节 */
export class FxSourceError extends Error {
  readonly source: FxSource;
  constructor(source: FxSource, message: string) {
    super(message);
    this.name = 'FxSourceError';
    this.source = source;
  }
}

export interface FxFetchOutcome {
  source: FxActiveSource;
  /** 界面上要显示的源名 */
  label: string;
  table: FxSourceTable;
}

/**
 * 取一次源汇率。**不写库、不改任何状态**。
 *
 * 失败一律抛 `FxSourceError`（带可读原因），交给调用方决定「不写库 + 如实提示」。
 * `off` 也抛 —— 它不是一个「取不到数的源」，而是「没启用」，调用方会先拦住它。
 */
export async function fetchSourceRates(
  source: FxSource,
  base: string,
  timeoutMs = 8000
): Promise<FxFetchOutcome> {
  if (source === 'off') throw new FxSourceError('off', '未启用公开汇率源');
  const ep = ENDPOINTS[source];

  /* base 来自库里的本位币（自己的数据），但仍是拼进 URL 的一段，照规矩校验一次。
     目的是让「这个值一定长得像个币种代码」这件事有据可查，而不是靠「它来自库里」。 */
  if (!/^[A-Z]{2,8}$/.test(base)) {
    throw new FxSourceError(source, `本位币 ${base} 不是合法的币种代码，拒绝拼接请求地址`);
  }

  let res: Response;
  try {
    res = await fetch(ep.url(base), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const e = err as Error;
    throw new FxSourceError(
      source,
      e.name === 'TimeoutError' || e.name === 'AbortError'
        ? `请求 ${ep.label} 超时（${timeoutMs}ms）`
        : `无法连接 ${ep.label}：${e.message}`
    );
  }

  if (!res.ok) {
    throw new FxSourceError(source, `${ep.label} 返回 HTTP ${res.status}`);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new FxSourceError(source, `${ep.label} 的响应不是合法 JSON`);
  }

  let table: FxSourceTable;
  try {
    table = ep.read(payload);
  } catch (err) {
    throw new FxSourceError(source, (err as Error).message);
  }

  return { source, label: ep.label, table };
}
