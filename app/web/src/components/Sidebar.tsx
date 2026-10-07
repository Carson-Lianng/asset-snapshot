/**
 * Sidebar.tsx —— 侧栏（品牌、开始盘点、主导航、页脚）
 *
 * DOM 与原型一致：`.sidebar > .brand + .side-pad + .nav + .side-foot`。
 * 页脚里的「重置演示数据」按钮必须保留 —— 它在原型里就有，是既定产品行为。
 *
 * ⚠ 2026-10-05 起**多了一项「帮助」**（配置组、紧挨「设置」），这是原型没有的
 * 新页面入口。它是全站可见元素；在逐像素外观线还没退役时，这会让 11 张基准图
 * 都出现同位置的差异，当时靠 `approved-divergence.json` 豁免
 * （该机制已随外观线删除，见《技术设计文档》§12.1）。
 * 「主要」组刻意**不动**：首页 / 账户 / 快照 / 报表 是日常动线，不该混进阅读类入口。
 *
 * 页脚文案的取舍同前：「重置演示数据」按数据模式给准话 —— 演示库里指向真正的
 * 切换入口，正式库里指向命令行（那条路要求手输 `--yes`，正是「整库替换」这种
 * 动作该有的门槛，见 §1.4 的 I-31）。
 *
 * ⚠ 2026-10-05 起 `.brand-mark` 内的 `¥` 文本换成 `<LogoMark />`（取景框 + 资产卡包）。
 * 品牌区同样是**全站可见元素**，改它当时会波及全部基准图（与「帮助」入口同一个处理）。
 * 卡包里的货币字符是**本位币的显示**、不是图形的一部分：默认 `$`，
 * 若要跟本位币联动，把 `currency` 换成 `currencyGlyph(getBaseCurrency())` 即可
 * （见 `Logo.tsx` 的 `currencyGlyph`）。
 */
import type { SnapshotSummaryDTO } from '@app/shared';
import { writable } from '../api/index.ts';
import { getBaseCurrency, daysBetween, todayISO } from '../lib/money.ts';
import { lastSnapshot } from '../lib/series.ts';
import { useToast } from './Toast.tsx';
import { LogoMark } from './Logo.tsx';
import { useUi } from '../state/ui.tsx';
import type { View } from '../router.ts';

interface NavItem {
  view: View;
  ico: string;
  label: string;
}

const MAIN_NAV: NavItem[] = [
  { view: 'home', ico: '◧', label: '首页' },
  { view: 'accounts', ico: '▤', label: '账户' },
  { view: 'snapshots', ico: '◉', label: '快照' },
  { view: 'reports', ico: '◪', label: '报表' }
];

const CONFIG_NAV: NavItem[] = [
  { view: 'settings', ico: '⚙', label: '设置' },
  /* 使用手册。图标沿用这套几何字符的调子（◧▤◉◪⚙），用问号表示「我不懂了」 */
  { view: 'help', ico: '?', label: '帮助' }
];

export function Sidebar({
  activeView,
  snapshots,
  accountCount,
  onNavigate,
  onStartInventory
}: {
  activeView: View;
  snapshots: readonly SnapshotSummaryDTO[];
  accountCount: number;
  onNavigate: (view: View) => void;
  onStartInventory: () => void;
}) {
  const toast = useToast();
  const { patch } = useUi();

  const last = lastSnapshot(snapshots);
  const gap = last ? daysBetween(last.date, todayISO()) : null;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <LogoMark />
        </div>
        <div className="brand-txt">
          <b>家底快照</b>
          <span>记录你的净值轨迹</span>
        </div>
      </div>

      <div className="side-pad">
        <button className="btn-primary-lg" onClick={onStartInventory}>
          ＋ 开始盘点
        </button>
      </div>

      <nav className="nav" id="nav">
        <div className="nav-label">主要</div>
        {MAIN_NAV.map(item => (
          <button
            key={item.view}
            className={'nav-item' + (activeView === item.view ? ' on' : '')}
            data-view={item.view}
            onClick={() => onNavigate(item.view)}
          >
            <span className="ico">{item.ico}</span>
            {item.label}
          </button>
        ))}
        <div className="nav-label">配置</div>
        {CONFIG_NAV.map(item => (
          <button
            key={item.view}
            className={'nav-item' + (activeView === item.view ? ' on' : '')}
            data-view={item.view}
            onClick={() => onNavigate(item.view)}
          >
            <span className="ico">{item.ico}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="side-foot" id="sideFoot">
        <div>
          <b>{getBaseCurrency()}</b> · {accountCount} 账户 · {snapshots.length} 期快照
        </div>
        <div>{last ? `上次盘点 ${last.date}（${gap} 天前）` : '尚无快照'}</div>
        <div style={{ marginTop: 6 }}>
          <button
            className="btn xs"
            onClick={() => {
              patch({ snapSel: null, cmpA: null, cmpB: null });
              toast(
                writable()
                  ? '把演示数据灌回来会整库覆盖，所以只在命令行做：npm run db:seed -- --yes。' +
                      '若想反过来「从演示切到正式」，请点内容区顶部的「开始正式记账」。'
                  : '当前离线预览是只读的；请打开 npm start 打印的服务端地址再操作。',
                'info',
                6000
              );
            }}
          >
            重置演示数据
          </button>
        </div>
      </div>
    </aside>
  );
}
