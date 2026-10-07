/**
 * fixture.ts —— 离线数据源（Step 3）
 *
 * 数据来自 `public/fixture.json`，它是 Step 2 服务端**逐端点实际响应**的冻结快照
 * （由 `npm run fixture:web` 生成，见 app/tools/data/export-web-fixture.mjs）。
 *
 * 这样做的好处：屏幕上显示的数字与 Step 2 已通过 2488 项验收的 API 响应逐位相同，
 * 前端组件化阶段引入的差异只可能来自「标记与样式」，不来自「数值」。
 *
 * 内容按 sha256 去重：`routes` 把路径映射到 blob 键，`blobs` 存实际响应体。
 */
import { DataSourceError, ReadOnlySourceError, type DataSource } from './source.ts';

export interface FixtureFile {
  generated_at: string;
  schema_version: number;
  app_version: string;
  route_count: number;
  blob_count: number;
  routes: Record<string, string>;
  blobs: Record<string, unknown>;
}

export interface FixtureSource extends DataSource {
  readonly kind: 'fixture';
  readonly meta: Omit<FixtureFile, 'routes' | 'blobs'>;
  /** 同步取数：fixture 已在内存里，首帧即可渲染，截图不受加载时序影响 */
  getSync<T>(path: string): T;
  /** 已冻结的路径清单（验收脚本用来核对覆盖率） */
  paths(): string[];
}

export async function createFixtureSource(url = './fixture.json'): Promise<FixtureSource> {
  let raw: FixtureFile;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = (await res.json()) as FixtureFile;
  } catch (err) {
    throw new DataSourceError(
      `无法加载离线数据 ${url}。请先运行 \`npm run fixture:web\` 生成。`,
      url,
      err
    );
  }

  const resolve = (path: string): unknown => {
    const key = raw.routes[path];
    if (key === undefined) {
      throw new DataSourceError(
        `离线数据中没有 \`${path}\`。该组合未被冻结 —— 请把它加入 app/tools/data/export-web-fixture.mjs 的清单后重新生成。`,
        path,
        { known: Object.keys(raw.routes).length }
      );
    }
    return raw.blobs[key];
  };

  return {
    kind: 'fixture',
    writable: false,
    meta: {
      generated_at: raw.generated_at,
      schema_version: raw.schema_version,
      app_version: raw.app_version,
      route_count: raw.route_count,
      blob_count: raw.blob_count
    },
    paths: () => Object.keys(raw.routes),
    getSync<T>(path: string): T {
      return resolve(path) as T;
    },
    async get<T>(path: string): Promise<T> {
      return resolve(path) as T;
    },
    /**
     * 离线快照是**只读**的：它是一次导出的静态 DTO，写回去没有意义。
     * 走到这里说明 UI 漏了按 `writable` 拦下 —— 拦法是「给一条提示 + 不发请求」，
     * **不是把按钮置灰**（见 `source.ts` 的 `DataSource.writable`）。
     * 这里抛出明确错误而不是静默假成功，否则「点了保存但什么也没发生」会被误判成通过。
     */
    async send<T>(): Promise<T> {
      throw new ReadOnlySourceError('<fixture>');
    },

    /** 离线快照没有服务端可导出 —— 与 `send` 同理，抛错而不是给一份假文件 */
    async download(): Promise<never> {
      throw new ReadOnlySourceError('<fixture>');
    }
  };
}
