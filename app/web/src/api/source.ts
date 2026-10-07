/**
 * source.ts —— 数据源抽象
 *
 * 整个前端只通过 `get(path)` 取数、`send(method, path, body)` 写数，
 * `path` 由 endpoints.ts 生成。Step 3 注入 fixtureSource（离线 DTO 快照），
 * Step 4 换成 httpSource（同源 fetch），页面代码一行不改 —— 这是「先定接口、再换实现」的落点。
 *
 * 为什么写路径只开一个 `send`（而不是 post/put/patch/delete 四个方法）：
 * Step 4 是「首次引入写路径」的一次改动，把它收成一个入口后，
 * 「写路径引入了什么」在 diff 里就是一处新增，而不是散落在四个方法里。
 */
export type DataSourceKind = 'fixture' | 'http';

export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** 一次文件下载的结果：原始字节 + 服务端建议的文件名 */
export interface DownloadedFile {
  /**
   * **原始字节**，不是文本。
   *
   * 刻意不用 `Response.text()`：按 WHATWG 规范，UTF-8 解码会**剥掉开头的 BOM**，
   * 而导出的 CSV 正需要那个 BOM —— Excel 靠它识别 UTF-8，没有它中文就是乱码。
   * 这类问题在浏览器里看不出来（下载下来的文件内容「看起来是对的」），
   * 只有用 Excel 打开才暴露。取字节、原样落盘，是唯一不走样的做法。
   */
  bytes: ArrayBuffer;
  /** 来自 `Content-Disposition`；服务端没给时为 null，由调用方兜一个名字 */
  filename: string | null;
}

export interface DataSource {
  readonly kind: DataSourceKind;
  /**
   * 为 false 时（fixture 源）UI 必须**拦下**写操作 —— 拦法是「点了给一条提示、
   * 请求根本不发出」，**不是把按钮置灰**（控件外观一字不改；理由见
   * `features/inventory/InventoryPage.tsx` 头部注释）。别等它抛错兜底。
   */
  readonly writable: boolean;
  /** path 形如 `/snapshots/snap-6` 或 `/reports/trend?metric=net_worth&mode=origin` */
  get<T>(path: string): Promise<T>;
  /** 写入口。`body` 缺省表示无请求体（如 DELETE） */
  send<T>(method: WriteMethod, path: string, body?: unknown): Promise<T>;
  /**
   * 取一个**文件**（导出用）。
   *
   * 为什么不直接 `window.open('/api/export/full')`：令牌走 `X-App-Token` **请求头**
   * （§10.2 ADR 第 3 条明令禁止放进 query —— 查询串会进服务端访问日志）。
   * 导航类请求带不了自定义头，所以必须是 fetch + 前端落盘。
   * 落盘由调用方做（`Blob` + 程序化 `<a download>`），数据源只负责把字节取回来。
   */
  download(path: string): Promise<DownloadedFile>;
}

export class DataSourceError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly detail?: unknown
  ) {
    super(message);
    this.name = 'DataSourceError';
  }
}

/** 离线 fixture 是只读快照；写操作走到这里说明 UI 漏了拦截（拦法=提示+不发请求，不是置灰） */
export class ReadOnlySourceError extends DataSourceError {
  constructor(path: string) {
    super(
      `当前是离线数据源，不能写入 \`${path}\`。请用服务端启动时打开的地址（默认真实 API）操作。`,
      path,
      { kind: 'fixture' }
    );
    this.name = 'ReadOnlySourceError';
  }
}
