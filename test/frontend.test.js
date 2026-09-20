'use strict';
/* 前端报告渲染与 Markdown 导出测试：在 vm 沙盒中加载真实 app.js（去掉 boot()），
 * 注入最小 DOM 桩，直接调用 renderReport / exportMarkdown 验证输出内容。 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { analyze } = require('../server/analyzer');
const seed = require('../server/seed');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---------- 加载 app.js ----------
let src = fs.readFileSync(__dirname + '/../public/app.js', 'utf8');
src = src.replace(/\nboot\(\);\s*$/, '\n');

const elements = {};
function makeEl() {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild() {},
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
  };
}
const ctx = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob,
  document: {
    querySelector: (sel) => (elements[sel] = elements[sel] || makeEl()),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    createElementNS: () => makeEl(),
  },
  window: { addEventListener() {} },
  fetch: async () => {
    throw new Error('fetch not available in test');
  },
});
vm.runInContext(src, ctx);

// 注入报告（示例剧目，含窄通道等待）
const report = analyze(seed.seedPlays[0]);
vm.runInContext(`state.doc = ${JSON.stringify(seed.seedPlays[0])}; state.report = ${JSON.stringify(report)};`, ctx);

// 捕获下载内容
const downloads = [];
vm.runInContext(
  `download = function (filename, content, mime) { __downloads.push({ filename, content, mime }); };`,
  Object.assign(ctx, { __downloads: downloads }),
);

console.log('== renderReport ==');
vm.runInContext('renderReport();', ctx);
const html = elements['#checkResult'].innerHTML;

ok('汇总栏包含窄通道统计', () => {
  assert.ok(html.includes('窄通道<b>1</b>'), 'narrowEdgeCount');
  assert.ok(html.includes('其中窄通道拥堵<b>0</b>'));
});
ok('首个不可能转场标注为路线被阻断', () => {
  assert.ok(html.includes('路线被阻断'));
});
ok('蘩漪结果行包含到达时间与等待标注', () => {
  assert.ok(html.includes('16s / 30s（含等待 8s）'), 'arrive/wait text');
});
ok('行程明细包含进入/离开时间与等待段', () => {
  assert.ok(html.includes('行程明细：0s 出发 → 16s 到达（含等待 8s）'));
  assert.ok(html.includes('在「台心」等待 8s'));
  assert.ok(html.includes('窄通道「台心 ↔ 左台口」正被 周萍（0s–8s） 占用'));
  assert.ok(html.includes('8s 进入「台心 → 左台口」（窄通道 · 8s）→ 16s 抵达「左台口」'));
});
ok('周萍原本即超时状态展示', () => {
  assert.ok(html.includes('超时（原本即超时）'));
  assert.ok(html.includes('21s / 20s'));
});
ok('提示区包含窄通道等待提示', () => {
  assert.ok(html.includes('受窄通道占用影响等待 8 秒'));
});

console.log('== exportMarkdown ==');
vm.runInContext('exportMarkdown();', ctx);
assert.strictEqual(downloads.length, 1);
const md = downloads[0].content;

ok('包含窄通道配置节', () => {
  assert.ok(md.includes('## 窄通道配置'));
  assert.ok(md.includes('| 左台口 ↔ 台心 | 8 秒 |'));
});
ok('包含调度明细与等待段', () => {
  assert.ok(md.includes('调度明细（按演员表顺序规划，时刻自换场开始计）'));
  assert.ok(md.includes('0s–8s 在「台心」等待窄通道（被 周萍（0s–8s） 占用）'));
  assert.ok(md.includes('8s 进入「台心 → 左台口」（窄通道），16s 抵达'));
  assert.ok(md.includes('到达 16s / 限 30s，共等待 8s'));
});
ok('表格含到达/时限与等待列', () => {
  assert.ok(md.includes('| 演员 | 状态 | 到达 / 时限 | 等待 | 路线 / 原因 |'));
  assert.ok(md.includes('| 蘩漪 | 按时可达 | 16 秒 / 30 秒 | 8 秒 |'));
});
ok('失败分类文案正确', () => {
  assert.ok(md.includes('周萍（原本即超时）') || md.includes('原本即超时'));
  assert.ok(md.includes('不可达'));
});

console.log('== 拥堵场景的渲染与导出 ==');
const congestionDoc = {
  name: '拥堵',
  zones: [
    { id: 'z1', name: '甲', x: 0, y: 0 },
    { id: 'z2', name: '乙', x: 0, y: 0 },
    { id: 'z3', name: '丙', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', a: 'z1', b: 'z2', seconds: 10, narrow: true },
    { id: 'e2', a: 'z2', b: 'z3', seconds: 3 },
  ],
  actors: [
    { id: 'a1', name: '甲演员' },
    { id: 'a2', name: '乙演员' },
  ],
  scenes: [
    {
      id: 's1',
      name: '一',
      durationFromPrev: null,
      placements: [
        { actorId: 'a1', from: null, to: 'z1' },
        { actorId: 'a2', from: null, to: 'z1' },
      ],
    },
    {
      id: 's2',
      name: '二',
      durationFromPrev: 15,
      placements: [
        { actorId: 'a1', from: 'z3', to: null },
        { actorId: 'a2', from: 'z3', to: null },
      ],
    },
  ],
  blocks: [],
};
const congReport = analyze(congestionDoc);
vm.runInContext(`state.doc = ${JSON.stringify(congestionDoc)}; state.report = ${JSON.stringify(congReport)};`, ctx);
vm.runInContext('renderReport();', ctx);
const html2 = elements['#checkResult'].innerHTML;

ok('拥堵状态徽标与文案', () => {
  assert.ok(html2.includes('窄通道拥堵'), 'status text');
  assert.ok(html2.includes('窄通道拥堵致超时'), 'verdict text');
  assert.ok(html2.includes('23s / 15s（含等待 10s）'));
});
ok('汇总栏拥堵计数', () => {
  assert.ok(html2.includes('其中窄通道拥堵<b>1</b>'));
});

downloads.length = 0;
vm.runInContext('exportMarkdown();', ctx);
const md2 = downloads[0].content;
ok('Markdown 中拥堵原因与状态', () => {
  assert.ok(md2.includes('乙演员（窄通道拥堵）') || md2.includes('窄通道拥堵'));
  assert.ok(md2.includes('共等待 10s'));
});

console.log('== 调度顺序优化的渲染与导出 ==');
// 顺序改善场景：甲 东→西（窄 8s），乙 西→北（窄 8s + 6s），限 20s；优化后乙先甲后
const orderOptDoc = {
  name: '顺序优化',
  zones: [
    { id: 'z1', name: '东', x: 0, y: 0 },
    { id: 'z2', name: '西', x: 0, y: 0 },
    { id: 'z4', name: '北', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', a: 'z1', b: 'z2', seconds: 8, narrow: true },
    { id: 'e2', a: 'z1', b: 'z4', seconds: 6 },
  ],
  actors: [
    { id: 'a1', name: '甲' },
    { id: 'a2', name: '乙' },
  ],
  scenes: [
    {
      id: 's1',
      name: '一',
      durationFromPrev: null,
      placements: [
        { actorId: 'a1', from: null, to: 'z1' },
        { actorId: 'a2', from: null, to: 'z2' },
      ],
    },
    {
      id: 's2',
      name: '二',
      durationFromPrev: 20,
      placements: [
        { actorId: 'a1', from: 'z2', to: null },
        { actorId: 'a2', from: 'z4', to: null },
      ],
    },
  ],
  blocks: [],
};
const orderOptReport = analyze(orderOptDoc);
vm.runInContext(`state.doc = ${JSON.stringify(orderOptDoc)}; state.report = ${JSON.stringify(orderOptReport)};`, ctx);
vm.runInContext('renderReport();', ctx);
const html3 = elements['#checkResult'].innerHTML;

ok('优化小节：精确标注与建议顺序', () => {
  assert.ok(html3.includes('调度顺序优化'), 'opt block');
  assert.ok(html3.includes('精确 · 分支限界'), 'exact tag');
  assert.ok(html3.includes('建议顺序：乙 → 甲'), 'suggested order');
});
ok('改善提示与当前/建议两套指标', () => {
  assert.ok(html3.includes('建议调整调度顺序'));
  assert.ok(html3.includes('超时 1 人 · 最晚到达 22s · 总等待 8s'), 'current metrics');
  assert.ok(html3.includes('超时 0 人 · 最晚到达 16s · 总等待 8s'), 'suggested metrics');
});
ok('建议方案逐人路线（含到达与等待）', () => {
  assert.ok(html3.includes('建议方案逐人路线（2 人'));
  assert.ok(html3.includes('16s / 20s（含等待 8s）'), '甲在建议方案中等 8s');
});

downloads.length = 0;
vm.runInContext('exportMarkdown();', ctx);
const md3 = downloads[0].content;
ok('Markdown 同步建议方案与精确标注', () => {
  assert.ok(md3.includes('#### 调度顺序优化（精确 · 分支限界，参与 2 人）'));
  assert.ok(md3.includes('- 当前顺序（演员表）：甲 → 乙 —— 超时 1 人 · 最晚到达 22s · 总等待 8s'));
  assert.ok(md3.includes('- 建议顺序：乙 → 甲 —— 超时 0 人 · 最晚到达 16s · 总等待 8s　**优于当前顺序**'));
  assert.ok(md3.includes('| 乙 | 14 秒 / 20 秒 | — | 西 → 东 → 北 |'));
});
ok('JSON 导出包含优化方案与是否精确', () => {
  const parsed = JSON.parse(JSON.stringify(orderOptReport));
  const o = parsed.transitions[0].optimization;
  assert.strictEqual(o.exact, true);
  assert.strictEqual(o.algorithm, 'branch-and-bound');
  assert.deepStrictEqual(o.suggested.orderActorNames, ['乙', '甲']);
  assert.ok(Array.isArray(o.suggested.results) && o.suggested.results.length === 2);
});

// 超过 8 人：贪心近似标注
const crowdDoc = (() => {
  const actors = [];
  const p1 = [];
  const p2 = [];
  for (let i = 1; i <= 9; i++) {
    actors.push({ id: 'a' + i, name: '演员' + i });
    p1.push({ actorId: 'a' + i, from: null, to: 'z1' });
    p2.push({ actorId: 'a' + i, from: 'z2', to: null });
  }
  return {
    name: '拥挤9人',
    zones: [
      { id: 'z1', name: '甲区', x: 0, y: 0 },
      { id: 'z2', name: '乙区', x: 0, y: 0 },
    ],
    edges: [{ id: 'e1', a: 'z1', b: 'z2', seconds: 5, narrow: true }],
    actors,
    scenes: [
      { id: 's1', name: '一', durationFromPrev: null, placements: p1 },
      { id: 's2', name: '二', durationFromPrev: 100, placements: p2 },
    ],
    blocks: [],
  };
})();
const crowdReport = analyze(crowdDoc);
vm.runInContext(`state.doc = ${JSON.stringify(crowdDoc)}; state.report = ${JSON.stringify(crowdReport)};`, ctx);
vm.runInContext('renderReport();', ctx);
const html4 = elements['#checkResult'].innerHTML;
ok('贪心近似在检查页明确标注', () => {
  assert.ok(html4.includes('近似 · 确定性贪心'));
  assert.ok(html4.includes('参与 9 人'));
});
downloads.length = 0;
vm.runInContext('exportMarkdown();', ctx);
ok('Markdown 标注近似结果', () => {
  assert.ok(downloads[0].content.includes('近似 · 确定性贪心（参与人数超过 8，结果可能非全局最优）'));
});

// 示例剧目：当前顺序已最优，建议顺序保持演员表顺序
vm.runInContext(`state.doc = ${JSON.stringify(seed.seedPlays[0])}; state.report = ${JSON.stringify(report)};`, ctx);
vm.runInContext('renderReport();', ctx);
const html5 = elements['#checkResult'].innerHTML;
ok('示例剧目：当前顺序即所选方案，建议顺序保持演员表顺序', () => {
  assert.ok(html5.includes('当前演员表顺序即为所选方案'));
  assert.ok(html5.includes('建议顺序：周萍 → 蘩漪 → 四凤'));
});

console.log(`\n全部通过：${passed} 项`);
