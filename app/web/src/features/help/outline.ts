/**
 * outline.ts —— 使用手册的**骨架**：章节 id、序号、标题、一句话简介
 *
 * 为什么把它从 `content.tsx` 里拆出来单独放一个**纯 .ts**：
 * 正文里含 JSX，Node 的类型擦除跑不了 `.tsx`，于是验收脚本就 import 不进
 * `HELP_CHAPTERS` —— 只能在脚本里把章节清单**再抄一遍**。那正是本项目反复
 * 栽过的坑（「把口径抄成两份，迟早有一份先被改掉」，见 `lib/drill.ts` 文件头）。
 *
 * 拆出来之后：页面读 `HELP_CHAPTERS`（= 本文件的骨架 + `content.tsx` 的正文），
 * 验收脚本读本文件，两边**同源**。加一章只需要改这里 + 在 `content.tsx` 里补正文。
 *
 * ⚠ `id` 同时是 URL 片段（`#help?sec=<id>`），改了会让外部链接失效。
 */

export interface HelpOutlineItem {
  /** 锚点 id —— URL 里就是 `#help?sec=<id>` */
  id: string;
  /** 目录里显示的章节号 */
  no: string;
  title: string;
  /** 章节标题右侧（顶栏 crumb 也用它）的一句话 */
  summary: string;
}

export const HELP_OUTLINE: readonly HelpOutlineItem[] = [
  { id: 'intro', no: '1', title: '这是什么', summary: '它做什么、不做什么' },
  { id: 'start', no: '2', title: '快速上手', summary: '三分钟跑通第一次盘点' },
  { id: 'concepts', no: '3', title: '核心概念', summary: '先看这一章，后面都靠它' },
  { id: 'scenarios', no: '4', title: '核心场景', summary: '六条可以照着做的动线' },
  { id: 'pages', no: '5', title: '页面导览', summary: '每个页面能干什么' },
  { id: 'faq', no: '6', title: '常见问题', summary: '八个最常被问到的疑问' },
  { id: 'data', no: '7', title: '数据与安全', summary: '数据在哪、怎么备份' },
  { id: 'skill', no: '8', title: '配套技能', summary: '用说话的方式盘账、问数（可选，独立交付）' },
  { id: 'glossary', no: '附', title: '名词速查', summary: '一页纸术语表' }
];

/** 章节元素 id 的唯一生成处 —— 目录、滚动高亮、深链定位、验收断言四处共用 */
export function chapterDomId(sec: string): string {
  return 'help-' + sec;
}
