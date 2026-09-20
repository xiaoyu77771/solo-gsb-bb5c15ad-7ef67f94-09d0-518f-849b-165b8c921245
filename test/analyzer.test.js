'use strict';
/* 分析器场景测试（临时脚本，验证后删除） */
const assert = require('assert');
const {
  analyze,
  validateDocument,
  earliestFreeStart,
  schedulePath,
  compareMetrics,
  simulateTransitionOrder,
  optimizeTransitionOrder,
  EXACT_ORDER_LIMIT,
} = require('../server/analyzer');
const seed = require('../server/seed');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('== earliestFreeStart ==');
ok('无占用时立即可进入', () => {
  assert.strictEqual(earliestFreeStart([], 5, 3), 5);
});
ok('冲突时推迟到占用结束', () => {
  assert.strictEqual(earliestFreeStart([{ start: 0, end: 8 }], 0, 5), 8);
});
ok('连续冲突链式推迟', () => {
  const ivs = [
    { start: 0, end: 8 },
    { start: 8, end: 15 },
  ];
  assert.strictEqual(earliestFreeStart(ivs, 0, 5), 15);
});
ok('空隙可容纳则不推迟', () => {
  const ivs = [
    { start: 0, end: 4 },
    { start: 10, end: 20 },
  ];
  assert.strictEqual(earliestFreeStart(ivs, 0, 5), 4); // [4,9) 放得下
});
ok('边界相接不算冲突', () => {
  assert.strictEqual(earliestFreeStart([{ start: 0, end: 8 }], 8, 5), 8);
});

console.log('== validateDocument 保留 narrow ==');
ok('narrow 字段规整为布尔', () => {
  const { doc, errors } = validateDocument({
    name: 't',
    zones: [{ id: 'z1' }, { id: 'z2' }],
    edges: [{ id: 'e1', a: 'z1', b: 'z2', seconds: 5, narrow: 1 }],
    scenes: [{ id: 's1', placements: [] }],
  });
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(doc.edges[0].narrow, true);
});
ok('旧文档无 narrow 字段默认为 false', () => {
  const { doc } = validateDocument({
    name: 't',
    zones: [{ id: 'z1' }, { id: 'z2' }],
    edges: [{ id: 'e1', a: 'z1', b: 'z2', seconds: 5 }],
    scenes: [{ id: 's1', placements: [] }],
  });
  assert.strictEqual(doc.edges[0].narrow, false);
});

console.log('== 示例剧目：窄通道等待调度 ==');
const seedReport = analyze(seed.seedPlays[0]);
ok('示例校验通过', () => {
  assert.strictEqual(seedReport.ok, true, JSON.stringify(seedReport.errors));
});
ok('窄通道配置进入报告', () => {
  assert.strictEqual(seedReport.stats.narrowEdgeCount, 1);
  assert.strictEqual(seedReport.narrowEdges.length, 1);
  assert.strictEqual(seedReport.narrowEdges[0].aZoneName, '左台口');
});
ok('第一组转场：蘩漪因相向共用窄通道等待 8 秒', () => {
  const t1 = seedReport.transitions[0];
  const fanyi = t1.results.find((r) => r.actorName === '蘩漪');
  assert.strictEqual(fanyi.status, 'ok');
  assert.strictEqual(fanyi.waitSeconds, 8);
  assert.strictEqual(fanyi.arriveAt, 16);
  assert.strictEqual(fanyi.schedule.waits.length, 1);
  const w = fanyi.schedule.waits[0];
  assert.strictEqual(w.zoneName, '台心');
  assert.strictEqual(w.startAt, 0);
  assert.strictEqual(w.endAt, 8);
  assert.strictEqual(w.blockers[0].actorName, '周萍');
});
ok('周萍先规划无等待，占用 [0,8)', () => {
  const t1 = seedReport.transitions[0];
  const zp = t1.results.find((r) => r.actorName === '周萍');
  assert.strictEqual(zp.status, 'ok');
  assert.strictEqual(zp.waitSeconds, 0);
  assert.strictEqual(zp.arriveAt, 16);
  const narrowLeg = zp.schedule.legs.find((l) => l.narrow);
  assert.strictEqual(narrowLeg.enterAt, 0);
  assert.strictEqual(narrowLeg.leaveAt, 8);
});
ok('首个不可能转场仍是阻断不可达（第二幕→第三幕）', () => {
  assert.strictEqual(seedReport.firstImpossible.transitionIndex, 2);
  assert.strictEqual(seedReport.firstImpossible.status, 'unreachable');
});
ok('第三幕→第四幕：周萍原本即超时（21 > 20）', () => {
  const t3 = seedReport.transitions[2];
  const zp = t3.results.find((r) => r.actorName === '周萍');
  assert.strictEqual(zp.status, 'timeout');
  assert.strictEqual(zp.seconds, 21);
});

/* 构造拥堵失败场景：A、B 依次过同一窄通道，B 等待后超时 */
const congestionDoc = {
  name: '拥堵测试',
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

console.log('== 窄通道拥堵致超时 ==');
const congReport = analyze(congestionDoc);
ok('先规划者按时（10+3=13 ≤ 15）', () => {
  const r = congReport.transitions[0].results[0];
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.arriveAt, 13);
});
ok('后规划者拥堵超时（等 10s，23 > 15）', () => {
  const r = congReport.transitions[0].results[1];
  assert.strictEqual(r.status, 'congested');
  assert.strictEqual(r.seconds, 13); // 静态不超时
  assert.strictEqual(r.waitSeconds, 10);
  assert.strictEqual(r.arriveAt, 23);
  assert.ok(r.reason.includes('窄通道'));
});
ok('统计与首个不可能状态为 congested', () => {
  assert.strictEqual(congReport.stats.congestedActorTransitions, 1);
  assert.strictEqual(congReport.stats.failedActorTransitions, 1);
  assert.strictEqual(congReport.firstImpossible.status, 'congested');
});

/* 绕路优于等待：窄通道被占用很久，绕行普通边更快 */
const detourDoc = {
  name: '绕路测试',
  zones: [
    { id: 'z1', name: '甲', x: 0, y: 0 },
    { id: 'z2', name: '乙', x: 0, y: 0 },
    { id: 'z3', name: '丙', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', a: 'z1', b: 'z2', seconds: 5, narrow: true }, // 直达窄通道
    { id: 'e2', a: 'z1', b: 'z3', seconds: 8 },
    { id: 'e3', a: 'z3', b: 'z2', seconds: 8 }, // 绕行 16s
  ],
  actors: [
    { id: 'a1', name: '先行' },
    { id: 'a2', name: '后行' },
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
      durationFromPrev: 30,
      placements: [
        { actorId: 'a1', from: 'z2', to: null },
        { actorId: 'a2', from: 'z2', to: null },
      ],
    },
  ],
  blocks: [],
};

console.log('== 等待不如绕路时选择绕路 ==');
const detReport = analyze(detourDoc);
ok('先行者走窄通道 5s', () => {
  const r = detReport.transitions[0].results[0];
  assert.strictEqual(r.arriveAt, 5);
  assert.strictEqual(r.schedule.legs.length, 1);
});
ok('后行者绕路 16s（而非等 5s 后走窄通道共 10s？不，等 5s+5s=10s 更快）', () => {
  // 占用 [0,5)，后行者 0s 到达窄通道，等至 5s，10s 到达 —— 比绕路 16s 快，应等待
  const r = detReport.transitions[0].results[1];
  assert.strictEqual(r.arriveAt, 10);
  assert.strictEqual(r.waitSeconds, 5);
});

const detourDoc2 = JSON.parse(JSON.stringify(detourDoc));
detourDoc2.edges[1].seconds = 3; // 绕行 3+3=6s
detourDoc2.edges[2].seconds = 3;
const detReport2 = analyze(detourDoc2);
ok('绕路更快时选择绕路（6s < 等 5s+5s）', () => {
  const r = detReport2.transitions[0].results[1];
  assert.strictEqual(r.arriveAt, 6);
  assert.strictEqual(r.waitSeconds, 0);
  assert.strictEqual(r.travelSeconds, 6);
  assert.strictEqual(r.seconds, 5); // 静态最短仍是窄通道 5s
  assert.strictEqual(r.schedule.legs.length, 2); // 走了两条边的绕路
});

console.log('== 失败演员也注册占用（影响后续调度） ==');
const regDoc = JSON.parse(JSON.stringify(congestionDoc));
regDoc.scenes[1].durationFromPrev = 12; // 甲演员 13s 也超时（原本即超时? 13>12 是）
regDoc.actors.push({ id: 'a3', name: '丙演员' });
regDoc.scenes[0].placements.push({ actorId: 'a3', from: null, to: 'z1' });
regDoc.scenes[1].placements.push({ actorId: 'a3', from: 'z3', to: null });
const regReport = analyze(regDoc);
ok('甲演员原本即超时（13 > 12），仍占用 [0,10)', () => {
  const r = regReport.transitions[0].results[0];
  assert.strictEqual(r.status, 'timeout');
});
ok('乙演员等待甲的占用（10s 后进入）', () => {
  const r = regReport.transitions[0].results[1];
  assert.strictEqual(r.waitSeconds, 10);
});
ok('丙演员等待链式占用（20s 后进入）', () => {
  const r = regReport.transitions[0].results[2];
  assert.strictEqual(r.waitSeconds, 20);
  assert.strictEqual(r.arriveAt, 33);
});

console.log('== 阻断不可达保持原有行为 ==');
ok('不可达分类与原因', () => {
  const doc = {
    name: '阻断',
    zones: [
      { id: 'z1', name: '甲', x: 0, y: 0 },
      { id: 'z2', name: '乙', x: 0, y: 0 },
      { id: 'z3', name: '丙', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e1', a: 'z1', b: 'z2', seconds: 5 },
      { id: 'e2', a: 'z2', b: 'z3', seconds: 5 },
    ],
    actors: [{ id: 'a1', name: '演员' }],
    scenes: [
      { id: 's1', name: '一', durationFromPrev: null, placements: [{ actorId: 'a1', from: null, to: 'z1' }] },
      { id: 's2', name: '二', durationFromPrev: 30, placements: [{ actorId: 'a1', from: 'z3', to: null }] },
    ],
    blocks: [{ fromSceneId: 's1', toSceneId: 's2', zoneIds: ['z2'] }],
  };
  const r = analyze(doc);
  const res = r.transitions[0].results[0];
  assert.strictEqual(res.status, 'unreachable');
  assert.ok(res.reason.includes('放开「乙」'));
  assert.strictEqual(res.schedule, null);
});

console.log('== 同一起点终点（无需移动） ==');
ok('legs 为空、0s 到达', () => {
  const doc = {
    name: '原地',
    zones: [{ id: 'z1', name: '甲', x: 0, y: 0 }],
    edges: [],
    actors: [{ id: 'a1', name: '演员' }],
    scenes: [
      { id: 's1', name: '一', durationFromPrev: null, placements: [{ actorId: 'a1', from: null, to: 'z1' }] },
      { id: 's2', name: '二', durationFromPrev: 10, placements: [{ actorId: 'a1', from: 'z1', to: null }] },
    ],
    blocks: [],
  };
  const r = analyze(doc);
  const res = r.transitions[0].results[0];
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.arriveAt, 0);
  assert.strictEqual(res.schedule.legs.length, 0);
});

console.log('== 调度顺序优化：指标比较与精确求解 ==');
ok('compareMetrics 字典序：超时人数 → 最晚到达 → 总等待', () => {
  assert.ok(compareMetrics([0, 99, 99], [1, 0, 0]) < 0); // 超时人数最优先
  assert.ok(compareMetrics([1, 5, 99], [1, 6, 0]) < 0); // 人数相同比最晚到达
  assert.ok(compareMetrics([1, 5, 3], [1, 5, 4]) < 0); // 再比总等待
  assert.strictEqual(compareMetrics([1, 5, 3], [1, 5, 3]), 0);
});
ok('精确求解人数上限为 8', () => {
  assert.strictEqual(EXACT_ORDER_LIMIT, 8);
});

/* 顺序优化场景：甲 东→西（窄 8s），乙 西→北（窄 8s + 6s），换场限 20s。
 * 当前顺序（甲先）：甲 [0,8) 占窄通道 8s 到；乙等 8s，16s 过窄通道、22s 到 → 超时 1 人。
 * 优化顺序（乙先）：乙 [0,8) 8s 过窄通道、14s 到；甲等 8s，16s 到 → 无人超时。 */
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
const opt1 = orderOptReport.transitions[0].optimization;

ok('当前顺序指标：超时 1 人、最晚 22s、总等待 8s', () => {
  assert.deepStrictEqual(
    [opt1.current.lateCount, opt1.current.maxArriveAt, opt1.current.totalWaitSeconds],
    [1, 22, 8],
  );
  assert.deepStrictEqual(opt1.current.orderActorNames, ['甲', '乙']);
});
ok('优化顺序更优：乙先甲后，超时 0 人、最晚 16s', () => {
  assert.strictEqual(opt1.improved, true);
  assert.deepStrictEqual(opt1.suggested.orderActorNames, ['乙', '甲']);
  assert.deepStrictEqual(
    [opt1.suggested.lateCount, opt1.suggested.maxArriveAt, opt1.suggested.totalWaitSeconds],
    [0, 16, 8],
  );
});
ok('不超过 8 人：分支限界精确解', () => {
  assert.strictEqual(opt1.exact, true);
  assert.strictEqual(opt1.algorithm, 'branch-and-bound');
  assert.strictEqual(opt1.actorCount, 2);
});
ok('建议方案含逐人路线与行程明细', () => {
  assert.strictEqual(opt1.suggested.results.length, 2);
  const first = opt1.suggested.results[0];
  assert.strictEqual(first.actorName, '乙');
  assert.strictEqual(first.arriveAt, 14);
  assert.strictEqual(first.late, false);
  assert.strictEqual(first.schedule.legs.length, 2); // 西 → 东 → 北
  assert.strictEqual(first.schedule.legs[0].fromZoneName, '西');
  const second = opt1.suggested.results[1];
  assert.strictEqual(second.actorName, '甲');
  assert.strictEqual(second.arriveAt, 16);
  assert.strictEqual(second.waitSeconds, 8); // 等乙先过窄通道
});
ok('默认调度结果保持演员表顺序不变', () => {
  const t = orderOptReport.transitions[0];
  assert.deepStrictEqual(t.results.map((r) => r.actorName), ['甲', '乙']);
  assert.strictEqual(t.results[1].status, 'congested'); // 原顺序下乙拥堵超时
});

console.log('== 指标相同：以原演员顺序稳定决胜 ==');
ok('对称场景（先后等价）保持原顺序', () => {
  const o = congReport.transitions[0].optimization; // 甲乙对称同路线，任何顺序指标相同
  assert.strictEqual(o.improved, false);
  assert.deepStrictEqual(o.suggested.orderActorIds, o.current.orderActorIds);
  assert.deepStrictEqual(
    [o.suggested.lateCount, o.suggested.maxArriveAt, o.suggested.totalWaitSeconds],
    [o.current.lateCount, o.current.maxArriveAt, o.current.totalWaitSeconds],
  );
});
ok('示例剧目各转场均给出优化小节且当前顺序已最优', () => {
  for (const t of seedReport.transitions) {
    assert.ok(t.optimization, '每个转场都有 optimization');
    assert.strictEqual(t.optimization.exact, true);
    assert.strictEqual(t.optimization.improved, false);
    assert.deepStrictEqual(t.optimization.suggested.orderActorIds, t.optimization.current.orderActorIds);
  }
  // 第一组转场：三人需移动且静态可达，全部参与
  assert.strictEqual(seedReport.transitions[0].optimization.actorCount, 3);
});

console.log('== 分支限界与暴力枚举一致 ==');
ok('4 人双窄通道场景：最优指标一致，并列时取最贴近原顺序者', () => {
  const bnbDoc = {
    name: '暴力对比',
    zones: [
      { id: 'z1', name: '一', x: 0, y: 0 },
      { id: 'z2', name: '二', x: 0, y: 0 },
      { id: 'z3', name: '三', x: 0, y: 0 },
      { id: 'z4', name: '四', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e1', a: 'z1', b: 'z2', seconds: 6, narrow: true },
      { id: 'e2', a: 'z2', b: 'z3', seconds: 4, narrow: true },
      { id: 'e3', a: 'z3', b: 'z4', seconds: 3 },
      { id: 'e4', a: 'z1', b: 'z4', seconds: 20 },
    ],
    actors: [
      { id: 'a1', name: '甲' },
      { id: 'a2', name: '乙' },
      { id: 'a3', name: '丙' },
      { id: 'a4', name: '丁' },
    ],
    scenes: [
      {
        id: 's1',
        name: '一',
        durationFromPrev: null,
        placements: [
          { actorId: 'a1', from: null, to: 'z1' },
          { actorId: 'a2', from: null, to: 'z2' },
          { actorId: 'a3', from: null, to: 'z3' },
          { actorId: 'a4', from: null, to: 'z4' },
        ],
      },
      {
        id: 's2',
        name: '二',
        durationFromPrev: 25,
        placements: [
          { actorId: 'a1', from: 'z4', to: null },
          { actorId: 'a2', from: 'z4', to: null },
          { actorId: 'a3', from: 'z1', to: null },
          { actorId: 'a4', from: 'z2', to: null },
        ],
      },
    ],
    blocks: [],
  };
  const rep = analyze(bnbDoc);
  const t = rep.transitions[0];
  const participants = [];
  for (const r of t.results) {
    if (r.offstage || r.status === 'unreachable' || r.fromZoneId === r.toZoneId) continue;
    participants.push({
      actorId: r.actorId,
      actorName: r.actorName,
      startId: r.fromZoneId,
      targetId: r.toZoneId,
      seconds: r.seconds,
    });
  }
  assert.strictEqual(participants.length, 4);
  // 暴力枚举全部排列（按索引字典序生成），取指标最优且最先达到者
  const perms = [];
  (function gen(pre, rest) {
    if (!rest.length) return perms.push(pre);
    for (let i = 0; i < rest.length; i++) gen([...pre, rest[i]], rest.filter((_, j) => j !== i));
  })([], participants.map((_, i) => i));
  assert.strictEqual(perms.length, 24);
  let best = null;
  for (const p of perms) {
    const sim = simulateTransitionOrder(bnbDoc, [], p.map((i) => participants[i]));
    const m = [0, 0, 0];
    for (const s of sim) {
      if (s.arriveAt > 25) m[0]++;
      if (s.arriveAt > m[1]) m[1] = s.arriveAt;
      m[2] += s.waitSeconds;
    }
    if (!best || compareMetrics(m, best.m) < 0) best = { order: p, m };
  }
  const opt = optimizeTransitionOrder(bnbDoc, [], participants, 25);
  assert.deepStrictEqual(opt.metrics, best.m, '指标与暴力最优一致');
  assert.deepStrictEqual(opt.order, best.order, '并列最优时取索引字典序最小（最贴近原顺序）');
  assert.deepStrictEqual(
    [t.optimization.suggested.lateCount, t.optimization.suggested.maxArriveAt, t.optimization.suggested.totalWaitSeconds],
    best.m,
    '报告建议指标与之一致',
  );
});

console.log('== 超过 8 人：确定性贪心并标注近似 ==');
function makeCrowdDoc(n) {
  const actors = [];
  const p1 = [];
  const p2 = [];
  for (let i = 1; i <= n; i++) {
    actors.push({ id: 'a' + i, name: '演员' + i });
    p1.push({ actorId: 'a' + i, from: null, to: 'z1' });
    p2.push({ actorId: 'a' + i, from: 'z2', to: null });
  }
  return {
    name: `拥挤${n}人`,
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
}
ok('9 名需移动演员 → 贪心近似并明确标注', () => {
  const o = analyze(makeCrowdDoc(9)).transitions[0].optimization;
  assert.strictEqual(o.actorCount, 9);
  assert.strictEqual(o.exact, false);
  assert.strictEqual(o.algorithm, 'greedy');
});
ok('8 人仍走分支限界精确解', () => {
  const o = analyze(makeCrowdDoc(8)).transitions[0].optimization;
  assert.strictEqual(o.exact, true);
  assert.strictEqual(o.algorithm, 'branch-and-bound');
});
ok('贪心结果确定（两次分析一致）且不劣于当前顺序', () => {
  const o1 = analyze(makeCrowdDoc(9)).transitions[0].optimization;
  const o2 = analyze(makeCrowdDoc(9)).transitions[0].optimization;
  assert.deepStrictEqual(o1.suggested.orderActorIds, o2.suggested.orderActorIds);
  assert.ok(
    compareMetrics(
      [o1.suggested.lateCount, o1.suggested.maxArriveAt, o1.suggested.totalWaitSeconds],
      [o1.current.lateCount, o1.current.maxArriveAt, o1.current.totalWaitSeconds],
    ) <= 0,
  );
});

console.log('== 优化参与范围：仅需要移动且静态可达的演员 ==');
ok('台下、不可达与原地不动者不参与', () => {
  const doc = JSON.parse(JSON.stringify(orderOptDoc));
  doc.zones.push({ id: 'z9', name: '孤岛', x: 0, y: 0 }); // 无邻接边 → 静态不可达
  doc.actors.push({ id: 'a3', name: '孤岛者' }, { id: 'a4', name: '台下者' }, { id: 'a5', name: '原地者' });
  doc.scenes[0].placements.push(
    { actorId: 'a3', from: null, to: 'z1' },
    { actorId: 'a4', from: null, to: null },
    { actorId: 'a5', from: null, to: 'z4' },
  );
  doc.scenes[1].placements.push(
    { actorId: 'a3', from: 'z9', to: null }, // 东 → 孤岛：不可达
    { actorId: 'a4', from: null, to: null }, // 台下
    { actorId: 'a5', from: 'z4', to: null }, // 北 → 北：原地不动
  );
  const rep = analyze(doc);
  const t = rep.transitions[0];
  assert.strictEqual(t.results.find((r) => r.actorName === '孤岛者').status, 'unreachable');
  assert.strictEqual(t.optimization.actorCount, 2); // 仅甲、乙参与
  assert.deepStrictEqual(t.optimization.current.orderActorNames, ['甲', '乙']);
});

console.log(`\n全部通过：${passed} 项`);
