/**
 * HelpPage.tsx —— 使用手册（`#help`）
 *
 * 版式：左「目录」sticky + 右正文。正文内容全部来自 `content.tsx`，
 * 本文件只负责三件事，不持有任何文案：
 *   1. 把 `HELP_CHAPTERS` 渲染成目录与正文（同源，不会两边对不上）
 *   2. 目录点选 / 深链定位（都走 hash，所以前进后退与分享链接都成立）
 *   3. 滚到哪一章就把目录哪一项点亮
 *
 * ⚠ 两个时序坑，改这里时别踩回去：
 *
 * ① **深链定位必须等一帧**。`Shell.tsx` 里有一条「切视图后把 `#main` 的 scrollTop
 *    归零」的 effect（deps 含 `route.view`）。React 的 effect 是**子先父后**，
 *    所以在 HelpPage 里同步 `scrollIntoView` 会被父组件随后的归零擦掉，
 *    表现是「链接里明明有 sec，页面却停在顶部」。放到 `requestAnimationFrame`
 *    里就落在两个 effect 之后了。
 *
 * ② **滚动高亮要跟着 `.main` 而不是 window**。本应用的滚动容器是 `#main`
 *    （`body{overflow:hidden}`、`.main{overflow-y:auto}`），window 的 scroll 事件
 *    永远不会触发。
 *
 * ③ **「顶部越过判定线」这条规则必须带一个掏底兜底**，否则最后一章永远亮不起来。
 *    实测（视口 1500×1340）：滚到底时 `glossary` 的标题距容器上沿还有 **456px** ——
 *    它自己 823px 高，被前一章垫着，而判定线在 96px，所以无论怎么滚都够不到。
 *    表现是「用户正读着最后一章，目录却指着倒数第二章」。故 `pick()` 里先判一次
 *    「是否已到底」。细节与理由见该分支的注释。
 *
 * 内容与本文档的映射见 `content.tsx` 头部注释。
 */
import { useEffect, useState } from 'react';
import { HELP_CHAPTERS, chapterDomId } from './content.tsx';

/** 目录高亮的判定线：距滚动容器顶部这么多像素以内，就算「正在读」这一章 */
const ACTIVE_LINE = 96;

/** 「已经滚到底」的容差（px）。见 `pick()` 的兜底分支 */
const BOTTOM_SLACK = 2;

export function HelpPage({ sec, onPick }: { sec: string | null; onPick: (sec: string) => void }) {
  /* 链接里的 sec 可能是个过期的 id（章节改过名），认不出就退回第一章 */
  const known = sec !== null && HELP_CHAPTERS.some(c => c.id === sec);
  const [active, setActive] = useState<string>(known && sec ? sec : HELP_CHAPTERS[0].id);

  /* ① 深链定位：`#help?sec=concepts` 直接滚到第 3 章 */
  useEffect(() => {
    if (!known || !sec) return;
    setActive(sec);
    const raf = window.requestAnimationFrame(() => {
      document.getElementById(chapterDomId(sec))?.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [sec, known]);

  /* ② 滚动高亮：取「顶部已越过判定线」的最后一章。
     用 rAF 节流 —— 直接绑 scroll 会在长页面上每帧触发一次 setState。 */
  useEffect(() => {
    const main = document.getElementById('main');
    if (!main) return;

    const last = HELP_CHAPTERS[HELP_CHAPTERS.length - 1].id;
    let raf = 0;
    const pick = () => {
      raf = 0;

      /* 兜底：已经滚到底就直接点亮最后一章。
         为什么必要 —— 最后一章往往够不到判定线：实测滚到底时 `glossary` 的标题
         距容器上沿还有 456px（它自己 823px 高，被前一章垫在下面），
         而判定线在 96px。不兜底的话，用户读着最后一章、目录却指着倒数第二章。
         ⚠ 内容不足一屏（没有滚动条）时不算「到底」，否则会永远点亮最后一章。 */
      const scrollable = main.scrollHeight - main.clientHeight > BOTTOM_SLACK;
      if (scrollable && main.scrollTop + main.clientHeight >= main.scrollHeight - BOTTOM_SLACK) {
        setActive(last);
        return;
      }

      const line = main.getBoundingClientRect().top + ACTIVE_LINE;
      let cur = HELP_CHAPTERS[0].id;
      for (const ch of HELP_CHAPTERS) {
        const el = document.getElementById(chapterDomId(ch.id));
        if (el && el.getBoundingClientRect().top <= line) cur = ch.id;
      }
      setActive(cur);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(pick);
    };

    main.addEventListener('scroll', onScroll, { passive: true });
    pick();
    return () => {
      main.removeEventListener('scroll', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="help-wrap" id="helpWrap">
      <aside className="help-toc" id="helpToc">
        <div className="help-toc-hd">目录</div>
        <div className="help-toc-list">
          {HELP_CHAPTERS.map(ch => (
            <button
              key={ch.id}
              className={'help-toc-item' + (active === ch.id ? ' on' : '')}
              data-sec={ch.id}
              onClick={() => {
                setActive(ch.id);
                onPick(ch.id);
              }}
            >
              <span className="no">{ch.no}</span>
              <span className="tt">{ch.title}</span>
            </button>
          ))}
        </div>
        <div className="help-toc-ft">
          共 {HELP_CHAPTERS.length} 章
          <br />
          边看边动手最有效
        </div>
      </aside>

      <div className="help-body" id="helpBody">
        {HELP_CHAPTERS.map(ch => (
          <section className="help-ch" id={chapterDomId(ch.id)} data-sec={ch.id} key={ch.id}>
            <div className="help-ch-hd">
              <span className="help-ch-no">{ch.no}</span>
              <h2>{ch.title}</h2>
              <span className="sum">{ch.summary}</span>
            </div>
            {ch.body}
          </section>
        ))}
      </div>
    </div>
  );
}
