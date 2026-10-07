/**
 * http.ts —— 真实 API 数据源（Step 4 起为**默认**源）
 *
 * 与 fixture 源实现同一个 `DataSource` 接口，路径键完全一致，
 * 因此切换只需要改 main.tsx 里的一行。
 *
 * 令牌来源（技术设计文档 §10.2 ADR，三条都是硬要求）：
 *   1. **从 URL fragment 读**（`#t=<token>`）—— fragment 不会被浏览器发给服务端，
 *      也就不会进入访问日志；
 *   2. 读到后立刻转存 **sessionStorage**，并把 fragment 从地址栏抹掉
 *      （留着会进浏览器历史与演示截图）；
 *   3. **禁止 localStorage**（XSS 可长期窃取）与**禁止查询参数**（会进服务端日志）。
 *
 * 服务端启动时会直接把带令牌的地址打印并打开，所以第 1 步是正常路径。
 */
import {
  DataSourceError,
  type DataSource,
  type WriteMethod
} from './source.ts';

export interface HttpSource extends DataSource {
  readonly kind: 'http';
  readonly writable: true;
  readonly baseUrl: string;
}

/** sessionStorage 的键；刻意不加前缀，本应用独占自己的源 */
export const TOKEN_STORAGE_KEY = 'asset-snapshot.token';

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // 某些隐私模式下访问会抛
  }
}

/** 把 `#t=...` 从地址栏抹掉，保留其余 fragment（路由用） */
function stripTokenFromHash(): void {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return;
  const rest = raw
    .split('&')
    .filter(p => p && !p.startsWith('t='))
    .join('&');
  const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
  window.history.replaceState(null, '', url);
}

/**
 * 取令牌。优先当前 fragment（首次进入），否则用本次会话里存下的。
 * 读到新令牌时会同步抹掉 fragment。
 */
export function readToken(hash = window.location.hash): string {
  const m = /(?:^#|[#&])t=([^&]+)/.exec(hash);
  if (m) {
    const token = decodeURIComponent(m[1]);
    const store = safeSession();
    if (store) {
      try {
        store.setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        /* 存不下也不影响本次使用：token 变量已经拿到 */
      }
    }
    stripTokenFromHash();
    return token;
  }
  const store = safeSession();
  try {
    return store?.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

async function problem(res: Response, path: string): Promise<never> {
  let detail: unknown = null;
  try {
    detail = await res.json();
  } catch {
    detail = await res.text().catch(() => null);
  }
  const message =
    detail && typeof detail === 'object' && 'error' in detail
      ? String((detail as { error: { message?: string } }).error?.message ?? res.statusText)
      : `HTTP ${res.status}`;
  throw new DataSourceError(message, path, detail);
}

export function createHttpSource(baseUrl = '/api', token = readToken()): HttpSource {
  const headers = (json: boolean): HeadersInit => {
    const h: Record<string, string> = {};
    if (token) h['X-App-Token'] = token;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  };

  return {
    kind: 'http',
    writable: true,
    baseUrl,
    async get<T>(path: string): Promise<T> {
      let res: Response;
      try {
        res = await fetch(baseUrl + path, { headers: headers(false) });
      } catch (err) {
        throw new DataSourceError(`网络请求失败：${path}`, path, err);
      }
      if (!res.ok) await problem(res, path);
      return (await res.json()) as T;
    },
    async send<T>(method: WriteMethod, path: string, body?: unknown): Promise<T> {
      const hasBody = body !== undefined;
      let res: Response;
      try {
        res = await fetch(baseUrl + path, {
          method,
          headers: headers(hasBody),
          body: hasBody ? JSON.stringify(body) : undefined
        });
      } catch (err) {
        throw new DataSourceError(`网络请求失败：${method} ${path}`, path, err);
      }
      if (!res.ok) await problem(res, path);
      // 204 / 空响应体：没有 JSON 可解，返回 null 由调用方忽略
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    },
    async download(path: string) {
      let res: Response;
      try {
        res = await fetch(baseUrl + path, { headers: headers(false) });
      } catch (err) {
        throw new DataSourceError(`网络请求失败：${path}`, path, err);
      }
      if (!res.ok) await problem(res, path);
      // 取字节而非文本：见 `DownloadedFile.bytes` 关于 BOM 的说明
      return {
        bytes: await res.arrayBuffer(),
        filename: filenameFrom(res.headers.get('content-disposition'))
      };
    }
  };
}

/**
 * 从 `Content-Disposition` 里取文件名。
 *
 * 先认 RFC 5987 的 `filename*=UTF-8''…`（服务端给非 ASCII 名时会用它），
 * 再回落到普通的 `filename="…"`。
 */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* 百分号编码非法时退回到普通形式 */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}
