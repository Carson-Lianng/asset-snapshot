/**
 * server-env.mjs —— 「以本仓库的服务端为子进程」时的唯一构造点：env 与 argv
 *
 * 本模块提供一对姊妹函数，一个管 `env`、一个管 `argv`，两者都只服务于同一件事：
 * 把 `app/server/src/main.ts` 起成子进程。
 *
 * ## 为什么必须有这么一个小东西
 *
 * 本项目有 5 个脚本要把 `app/server/src/main.ts` 起成子进程
 * （`start` / `dev` 之外的验收与导出脚本）。它们都必须做同一件事：
 * **把 `NODE_OPTIONS` 剔掉**。这件事的原因不写在调用点，写在这里，只有一份。
 *
 * ## 为什么要剔 `NODE_OPTIONS`
 *
 * 宿主环境（IDE、沙箱包装器、CI 包装脚本）常用它 `--require` 预载一个 shim。
 * 本项目的服务端**直接跑 `.ts` 入口**（靠 Node 原生类型剥离，没有构建步骤），
 * 被 shim 插进来之后，子进程会停在一种极难归因的状态：
 *
 *   · 进程活着（不退出）；
 *   · 端口不监听；
 *   · stdout / stderr 一个字都不输出（连「启动失败」都没有）。
 *
 * 上层于是只看到一句「服务在 http://127.0.0.1:xxxxx 上未就绪」，`stderr` 为空。
 * 实测（2026-10-04）本沙箱的 `NODE_OPTIONS` 为
 * `--require=".../cli/vendor/shim/node-language-shim.cjs"`，剔除后服务 1.5 秒内就绪。
 *
 * ## 两条配套约定
 *
 * 1. **子进程的 stdout 也要读走**。只接 `stderr` 时，服务启动横幅（写在 stdout）
 *    可能把管道缓冲区写满，反过来把子进程卡住 —— 又一个「服务起不来」的假象。
 * 2. 子进程只该受显式传进去的那几个变量控制，不要指望它继承调用方的 shell 配置。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 构造子进程的 env：继承当前环境、叠加调用点显式指定的变量，并**剔掉 `NODE_OPTIONS`**。
 *
 * @param {Record<string, string | undefined>} extra 该脚本要显式设定的变量
 * @returns {NodeJS.ProcessEnv} 可直接交给 `spawn` 的 env
 */
export function serverEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * 服务端入口的 node 参数（`serverEnv` 的姊妹函数：一个管 env，一个管 argv）。
 *
 * ## 为什么 `.env` 由这里加载，而不是各调用点自己读
 *
 * `.env` / `.env.example` 与设计文档 §15 都写着「真实值请写入 `.env`」，
 * 但**代码里从来没有读过它** —— Node 不会自动加载 `.env`，于是用户建了 `.env`、
 * 把 `PORT` 改成固定端口，什么都不会发生（2026-10-04 实测：全仓搜不到
 * `dotenv` / `--env-file` / `process.loadEnvFile`）。这类「文档承诺了、代码没做」
 * 的缺口必须在唯一的加载点上补掉，否则它会以「改了配置没反应」的形式反复出现。
 *
 * `--env-file` 的两条语义正好是我们要的：
 *   · **已是环境变量的值优先**。`PORT=5199 npm start` 能压过 `.env` 里的 `PORT=5188`；
 *     调用点显式传进去的变量同理（`dev.mjs` 传 `PORT=5174` 不会被 `.env` 顶掉）。
 *   · 只在文件**存在**时加这个参数（用 `--env-file-if-exists` 会在缺文件时往 stderr
 *     打一行英文提示，启动横幅里多一句噪音）。
 *
 * **验收脚本一律不要用这个函数**：它们必须自足 —— 各自注入临时 `DATA_DIR` 与端口，
 * 一旦继承了 `.env` 里的固定端口就会互相撞车。
 *
 * @param {string} entry 服务端入口的绝对路径
 * @returns {string[]} 可直接交给 `spawn(process.execPath, …)` 的参数数组
 */
export function serverNodeArgs(entry) {
  /* ⚠ 上溯**三级**：本文件住在 `app/tools/lib/`，相对仓库根深 3 层
     （与 `app/tools/verify` `run` `data` `pack` 下那 17 处 `'..','..','..'` 同一约定）。

     这里曾写成 `'../..'` —— 只上溯到 `app/`，于是去找 `app/.env`（不存在），
     `existsSync` 为 false，`--env-file` **干脆不加**，`.env` 被整体忽略。
     症状极具迷惑性：**服务照常启动**（只是 `PORT` 落回默认的 0 = 随机端口），
     `.env` 里的 `OPEN_BROWSER` / `HOST` / `LOG_LEVEL` / `BACKUP_*` / `FX_SOURCE`
     全部静默失效。而 `npm run dev` 因为自己显式传 `PORT`，看不出异常 ——
     坏的恰好是最常用的那个入口 `npm start`。
     实测（2026-10-06）：`npm start` 起在 55966，而 `.env` 写的是 5188。

     教训与「五类归位」那次的漏网同型：**目录一搬家，凡是把深度写成字面量的地方
     都要重新数一遍**，而这类错误没有任何脚本会报（`.env` 是可选输入）。 */
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const envFile = join(root, '.env');
  return existsSync(envFile) ? ['--env-file', envFile, entry] : [entry];
}
