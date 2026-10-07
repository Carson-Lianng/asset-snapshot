/* ══════════════════════════════════════════════════════════════════
   家底快照 · 官网 —— 站点脚本
   ══════════════════════════════════════════════════════════════════

   ## 为什么这里只有一件事

   站点是**零依赖手写静态页**（PRD §5.4）：无框架、无 CDN、无 web font。
   脚本只做一件 CSS 做不到的事 —— **顶栏锚点跟随当前区块高亮**。

   除此之外一律不用 JS：
   · 移动端菜单不是「JS 抽屉」而是 CSS 断点隐藏（`.tb-nav{display:none}`）——
     隐藏了也不影响转化，因为两颗按钮**始终在**（PRD §3.3）；
   · 截图用 `loading="lazy"`、展开用原生 `<details>`、锚点滚动用 CSS
     `scroll-behavior` + `scroll-margin-top`。

   ⇒ 因此本文件**不是**必需项：禁用它，整站内容、锚点与所有链接照常工作。
   ## 为什么用 IntersectionObserver 而不是 scroll 事件

   本页没有内部滚动容器（`body` 直接滚动），两者都能用。选前者是因为它
   天然把「进入视口多少」表达成阈值，而且不产生每帧回调 —— 滚动时的
   主线程更干净。回调里只切一个 class，动画交给 CSS。
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var nav = document.querySelector('.tb-nav');
  if (!nav) return;

  /* 顶栏锚点 → 它指向的区块。两侧顺序一一对应，所以直接按 href 取元素。 */
  var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
  var targets = links
    .map(function (a) {
      return document.getElementById(a.getAttribute('href').slice(1));
    })
    .filter(Boolean);

  if (!targets.length || typeof IntersectionObserver !== 'function') return;

  /* 决策线：粘性顶栏下沿再往下一点。区块「跨过」这条线即算当前区块，
     这样滚动到某区块上半部时它就已经点亮，不必等它填满整个视口。 */
  var LINE = 0.28;

  var visible = new Set();

  function apply() {
    /* 取可见集合中**文档顺序最靠前**的那个 —— 两个区块同时在视口里时，
       点亮上面那个与人的阅读直觉一致（往下滚，亮点跟着往下走）。 */
    var best = null;
    for (var i = 0; i < targets.length; i++) {
      if (visible.has(targets[i])) {
        best = targets[i];
        break;
      }
    }
    /* 一个都不在视口（页首 Hero 或页脚）⇒ 全灭，而不是死钉在上一项上 */
    links.forEach(function (a) {
      a.classList.toggle('on', best !== null && a.getAttribute('href') === '#' + best.id);
    });
  }

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      });
      apply();
    },
    { rootMargin: '-15% 0px -' + Math.round((1 - LINE) * 100) + '% 0px', threshold: 0 }
  );

  targets.forEach(function (el) {
    io.observe(el);
  });
})();
