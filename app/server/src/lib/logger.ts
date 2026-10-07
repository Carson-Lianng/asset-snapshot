/**
 * 结构化日志（技术设计文档 §11，ADR-11）
 *
 * 两条硬约束：
 *   1. **脱敏**：绝不记录金额、账户名、平台名、备注等业务内容，只记 ID、数量与状态。
 *      资产数据属于高敏感信息，日志文件可能被同步到云盘或随备份外发。
 *   2. **只记 JSON 行**，常设字段为 ts / level / request_id / method / path / status /
 *      duration_ms / code，便于 grep 与后续采集。
 *      **唯一的例外是未预期异常**：`app.ts` 的 onError 会额外带 `error_name` /
 *      `error_message` / `stack`（它自己的注释写着「日志留完整堆栈」）。
 *      pretty 格式必须把它们打出来 —— 否则响应里那句
 *      「服务内部错误，请凭 request_id 查看日志」会指向一条**没有原因**的日志（见 I-42）。
 *
 * 文件落盘与保留期清理属于 Step 5（加固），本步先落到 stdout。
 */
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

/** 兜底脱敏：即使调用方误传，也拦一层 */
const REDACT_PATHS = [
  'amount', 'amounts', 'money', 'principal', 'balance', 'net_worth',
  'account_name', 'account_name_snapshot', 'platform_name', 'platform_name_snapshot',
  'note', 'tags', 'items', '*.amount', '*.principal', '*.note', '*.name'
];

const LEVEL_COLOR: Record<number, string> = {
  10: '\x1b[90m', 20: '\x1b[36m', 30: '\x1b[32m', 40: '\x1b[33m', 50: '\x1b[31m', 60: '\x1b[41m'
};
const RESET = '\x1b[0m';

function prettyStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      const line = chunk.toString().trim();
      if (!line) return cb();
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const lvl = Number(o.level ?? 30);
        const time = new Date(Number(o.time ?? Date.now())).toISOString().slice(11, 23);
        const parts = [
          `${LEVEL_COLOR[lvl] ?? ''}${String(o.level ?? 'info').toUpperCase().padEnd(5)}${RESET}`,
          `\x1b[90m${time}\x1b[0m`,
          String(o.msg ?? '')
        ];
        for (const k of [
          'request_id', 'method', 'path', 'status', 'duration_ms', 'code', 'uid', 'version',
          /* 未预期异常的三件套（见文件头说明 2）。漏掉它们时，控制台上只会剩下一行
             `unhandled_error request_id=…` —— 排查的人拿到 request_id 也无从下手。 */
          'error_name', 'error_message'
        ]) {
          if (o[k] !== undefined) parts.push(`\x1b[90m${k}=\x1b[0m${String(o[k])}`);
        }
        process.stdout.write(parts.join(' ') + '\n');
        /* 堆栈是多行的，塞进上面那一行会破坏「一条日志一行」的约定；
           作为续行单独输出，既不丢信息，也不影响按行 grep 主记录。 */
        if (typeof o.stack === 'string') {
          for (const line of o.stack.split('\n')) {
            process.stdout.write(`\x1b[90m${line}\x1b[0m\n`);
          }
        }
      } catch {
        process.stdout.write(line + '\n');
      }
      cb();
    }
  });
}

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  if (opts.pretty) {
    return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, prettyStream());
  }
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
}

export type { Logger };
