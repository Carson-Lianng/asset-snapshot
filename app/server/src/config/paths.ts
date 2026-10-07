/**
 * 路径与版本（供启动流程与脚本共用）
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** app/server/src/config → 仓库根 */
export const REPO_ROOT = resolve(HERE, '../../../..');

export const FIXTURE_FILE = resolve(REPO_ROOT, 'app/fixtures/demo-seed.json');

/** 前端构建产物目录（`npm run build` 的输出，ADR-12 单端口形态的静态根） */
export const WEB_DIST = resolve(REPO_ROOT, 'app/web/dist');

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();
