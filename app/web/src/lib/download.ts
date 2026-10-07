/**
 * lib/download.ts —— 把服务端返回的文件落到用户磁盘
 *
 * 顶栏的「导出全量备份」与设置页的三个导出按钮都走这里，避免落盘逻辑出现第二份。
 *
 * 两个容易踩的点：
 *  1. **必须用原始字节**。`Response.text()` 按规范会剥掉 UTF-8 BOM，而导出的 CSV
 *     正靠 BOM 让 Excel 认出编码 —— 少了它就是乱码，而且在浏览器里完全看不出来。
 *     字节在 `dataSource().download()` 里已经保住了，这里不要图省事再转一道文本。
 *  2. **`revokeObjectURL` 要延后**。立刻释放会让部分浏览器来不及开始下载，
 *     表现为「点了没反应」——而下载其实已经排队了。延迟释放即可。
 */
import { dataSource } from '../api/index.ts';

/** Blob + 程序化 `<a download>`；返回实际使用的文件名 */
export function saveBytes(bytes: ArrayBuffer, filename: string, mime: string): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

/**
 * 下载一个导出端点并落盘。
 *
 * @param path 端点路径（令牌走请求头，所以不能用 `<a href>` 直接指过去）
 * @param fallbackName 服务端没给 `Content-Disposition` 时的兜底文件名
 * @returns 实际落盘的文件名（供 toast 显示）
 */
export async function downloadFile(path: string, fallbackName: string, mime: string): Promise<string> {
  const f = await dataSource().download(path);
  return saveBytes(f.bytes, f.filename ?? fallbackName, mime);
}
