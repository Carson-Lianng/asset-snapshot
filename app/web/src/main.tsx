/**
 * main.tsx —— 应用启动
 *
 * 启动顺序是有意的，不要合并：
 *   1. 选定数据源 —— **Step 4 起默认是真实 API**；
 *   2. **在渲染前**把常用路径预热进缓存；
 *   3. 注入币种符号表（`money()` 显示币种符号时要用）；
 *   4. 补默认 hash，挂载 React。
 *
 * 数据源开关（Step 4 决策）：
 *   · 缺省          → 真实 API（`/api`，同源）
 *   · `?data=fixture` → 离线 DTO 快照，用于 Step 3 的逐像素外观回归
 *
 * 为什么把默认反过来：Step 4 的验收条款是「数据源切换到 API，移除 localStorage 持久化」。
 * 若默认仍是 fixture，那样验的其实是「离线快照还能渲染」，与条款无关。
 *
 * 无令牌时**不静默 401**，而是渲染一块明确的引导页 —— 服务端启动时会把带令牌的地址
 * 打印并打开，正常路径不会走到这里；走到这里通常是手敲了地址或换了浏览器窗口。
 */
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
/* 让 #root 对布局透明 —— 原型里 .sidebar / .main 是 <body> 的直接子元素（见该文件注释） */
import './styles/mount.css';
import { cached, prefetch, setDataSource } from './api/index.ts';
import { ep } from './api/endpoints.ts';
import { createFixtureSource, type FixtureSource } from './api/fixture.ts';
import { createHttpSource, readToken } from './api/http.ts';
import { setCurrencyTable } from './lib/money.ts';
import { ensureDefaultHash } from './router.ts';
import { App } from './App.tsx';

/** HTTP 源下的最小预热集：外壳与最常见的首个视图 */
const BOOT_PATHS: readonly string[] = [
  ep.settings(),
  ep.rates(),
  ep.baseCurrencyHistory(),
  ep.currencies(true),
  ep.platforms(true),
  ep.categories(true),
  ep.tags(true),
  ep.accounts(),
  ep.snapshots(),
  ep.returnsTrend()
];

interface CurrenciesDTO {
  items: Array<{ code: string; symbol: string }>;
}

interface SettingsLite {
  base_currency: string;
}

/** 缺少访问令牌时的引导页（深链会带着 fragment 令牌，正常不会看到它） */
function renderMissingToken(root: HTMLElement): void {
  const box = document.createElement('div');
  box.id = 'boot-guard';
  box.setAttribute('style', [
    'max-width:640px',
    'margin:12vh auto',
    'padding:28px 32px',
    'border:3px solid #111',
    'box-shadow:8px 8px 0 #111',
    'background:#fffdf5',
    'font:16px/1.7 ui-sans-serif,system-ui,"PingFang SC",sans-serif',
    'color:#111'
  ].join(';'));

  const h = document.createElement('h1');
  h.textContent = '需要访问令牌';
  h.setAttribute('style', 'margin:0 0 12px;font-size:22px;letter-spacing:-0.01em');

  const p1 = document.createElement('p');
  p1.setAttribute('style', 'margin:0 0 10px');
  p1.textContent = '这是一个只跑在本机的服务，所有 /api 请求都要带访问令牌。';

  const p2 = document.createElement('p');
  p2.setAttribute('style', 'margin:0 0 10px');
  p2.textContent = '请回到启动服务的那个终端窗口，打开它打印出的地址（形如 http://127.0.0.1:<端口>/#t=<令牌>）。';

  const p3 = document.createElement('p');
  p3.setAttribute('style', 'margin:16px 0 0;font-size:13px;color:#555');
  p3.textContent = '只想看离线演示数据？在地址后加 ?data=fixture 即可（只读，不能保存）。';

  box.append(h, p1, p2, p3);
  root.replaceChildren(box);
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const wantFixture =
    params.get('data') === 'fixture' || import.meta.env.VITE_DATA_SOURCE === 'fixture';

  const root = document.getElementById('root');
  if (!root) throw new Error('缺少挂载点 #root');

  let source: FixtureSource | ReturnType<typeof createHttpSource>;
  if (wantFixture) {
    source = await createFixtureSource();
  } else {
    const token = readToken();
    if (!token) {
      renderMissingToken(root);
      return;
    }
    source = createHttpSource('/api', token);
  }
  setDataSource(source);

  if (source.kind === 'fixture') {
    await prefetch(source.paths());
  } else {
    // 预热失败不阻断启动：各页面自带错误态，这里只是让首屏少几次往返
    await prefetch(BOOT_PATHS).catch(() => undefined);
  }

  const currencies = cached<CurrenciesDTO>(ep.currencies(true));
  const settings = cached<SettingsLite>(ep.settings());
  if (currencies && settings) {
    setCurrencyTable(currencies.items, settings.base_currency);
  }

  ensureDefaultHash();

  createRoot(root).render(<App />);
}

void boot();
