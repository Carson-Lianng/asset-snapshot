/**
 * CSV 编解码（零依赖，RFC 4180 的实用子集）
 *
 * 两个容易被忽略但会真实咬人的点：
 *
 *   1. **BOM**。Excel 打开不带 BOM 的 UTF-8 CSV 会把中文显示成乱码。
 *      导出的文件是给人用 Excel 打开的，所以编码时加 `\ufeff`；
 *      解码时**必须剥掉**，否则第一列的表头会变成 `\ufeff账户名`，
 *      按列名取值全部落空 —— 这类缺陷不会报错，只会静默少掉一列。
 *
 *   2. **行分隔符**。RFC 4180 规定 `CRLF`，Excel 也认；解码时三种都要认
 *      （`\r\n` / `\n` / `\r`），因为用户可能从别处导出再导入。
 */

/** 单元格值：导出时一律转字符串 */
export type CsvValue = string | number | boolean | null | undefined;

function escapeCell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  // 含分隔符 / 引号 / 换行才需要包裹
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 二维数组 → CSV 文本（带 BOM，CRLF 行尾） */
export function encodeCsv(rows: ReadonlyArray<ReadonlyArray<CsvValue>>): string {
  const body = rows.map(r => r.map(escapeCell).join(',')).join('\r\n');
  return `\ufeff${body}\r\n`;
}

/**
 * CSV 文本 → 二维数组。
 *
 * 逐字符扫描而不是 `split(',')`：引号内的逗号与换行不算分隔符，
 * 而备注、账户名里出现逗号是常事。
 */
export function decodeCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'; // 转义的双引号
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      // 吞掉 CRLF 的 LF，孤立 CR 也当换行
      if (src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  // 末行：有内容（或有未闭合的单元格）才收
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  // 丢掉纯空行（末尾换行会产生一行空）
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

/**
 * 带表头的 CSV → 对象数组。
 *
 * 表头做 **trim** 后再匹配：用户在 Excel 里手改过表头时，
 * 尾随空格是极常见的，而按列名取值失败是静默的。
 */
export function decodeCsvWithHeader(text: string): Array<Record<string, string>> {
  const rows = decodeCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(cells => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) rec[h] = (cells[i] ?? '').trim();
    });
    return rec;
  });
}
