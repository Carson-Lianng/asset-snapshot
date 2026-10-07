#!/usr/bin/env node
/**
 * 生产构建：先校验类型，再产出前端静态产物（技术设计文档 §13.1 / ADR-12）
 *
 * 顺序是有意的：**类型不过就不构建**。Vite 的 esbuild 转译会直接丢掉类型错误
 * （它不做类型检查），因此「能 build 成功」并不意味着「类型是对的」。
 *
 * 产物：app/web/dist（含 fixture.json）。随后 `npm start` 由服务进程一并托管，
 * 形成真正的单端口形态。
 *
 * 用法：npm run build
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WEB = join(ROOT, 'app/web');
const DIST = join(WEB, 'dist');
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
const VITE = join(ROOT, 'node_modules/vite/bin/vite.js');

function run(name, cmd, args, cwd) {
  return new Promise((ok, bad) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? ok() : bad(new Error(`${name} 失败（exit ${code}）`))));
    child.on('error', bad);
  });
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

try {
  if (!existsSync(VITE)) throw new Error(`未找到 vite（${VITE}）—— 请先 npm install`);

  process.stdout.write('  1/2 类型检查（tsc --noEmit）…\n');
  await run('tsc', process.execPath, [TSC, '-p', join(WEB, 'tsconfig.json'), '--noEmit'], ROOT);

  process.stdout.write('  2/2 构建前端产物（vite build）…\n');
  await run('vite', process.execPath, [VITE, 'build'], WEB);

  const kb = (dirSize(DIST) / 1024).toFixed(0);
  const fixture = existsSync(join(DIST, 'fixture.json'));
  process.stdout.write(
    `\n  构建完成 → app/web/dist（${kb} KB）\n` +
      `    离线数据 fixture.json：${fixture ? '已包含' : '缺失 —— 请先运行 npm run fixture:web'}\n` +
      `    下一步：npm start 由服务进程托管该目录（单端口）\n\n`
  );
} catch (err) {
  process.stderr.write(`\n  构建失败：${err.message}\n\n`);
  process.exit(1);
}
