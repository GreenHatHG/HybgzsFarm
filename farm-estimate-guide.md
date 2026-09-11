# 农场（cdk.hybgzs.com）种子 × 地块 预估实现指南

目标：在**种下去之前**预估「某种子种在某块地」需要的时间和产量，算法要长期稳定、不硬编码网站参数。

## 1. 数据来源（全部为服务端权威接口，已实测验证）

脚本启动时拉一次并缓存，共 3 个 GET，带 cookie（credentials: 'include'）：

| 接口 | 关键字段 | 说明 |
|---|---|---|
| `GET /api/farm/plots` | 地块总数/解锁数 | ⚠️ `unlockedPlotLevels` 字段的键**不是** plotIndex（实测 0–5 号地接口标 Lv1，界面与作物实际倍数均为 Lv7），**不可用作等级来源**，仅用 totalSlots 等统计 |
| `GET /api/farm/seeds` | `seeds[]` | 全部 31 种种子：`id/name/growthTime(秒)/harvestQuantity(基础产量)/harvestValue(单个售价)/price(种子价格)` |
| `GET /api/farm/codex/mechanics` | `data.params.plots` | 算法系数：`upgradeMaxLevel`(7)、`yieldPercentPerLevel`(33.33)、`growthSpeedPercentPerLevel`(6.67) |

这三个接口基本静态（游戏配置），一次会话缓存即可，遍历种子×地块全部本地计算，零额外请求。

## 2. 预估算法（公式写死一行乘法，系数从接口读，绝不硬编码 33.33/6.67/7）

```js
async function loadParams() {
  const [plots, seeds, mech] = await Promise.all([
    fetch('/api/farm/plots', {credentials:'include'}).then(r=>r.json()),
    fetch('/api/farm/seeds', {credentials:'include'}).then(r=>r.json()),
    fetch('/api/farm/codex/mechanics', {credentials:'include'}).then(r=>r.json()),
  ]);
  const p = mech.data.params.plots;
  return {
    // ⚠️ 不使用 plots.data.unlockedPlotLevels —— 实测该字段键与地块错位（2026-09-11 实测）
    plotLevels: {},   // 由对账阶段从 /api/farm/crops 的 yieldMultiplier 反推填入
    maxLevel: p.upgradeMaxLevel,
    yieldPct: p.yieldPercentPerLevel,          // 每级产量 +33.33%
    speedPct: p.growthSpeedPercentPerLevel,    // 每级时间 −6.67%
    seeds: seeds.seeds,
  };
}

function estimate(seed, plotLevel, cfg) {
  const n = plotLevel - 1;
  const yieldMul = 1 + cfg.yieldPct / 100 * n;   // Lv7 → ×3.00, Lv5 → ×2.33
  const timeMul  = 1 - cfg.speedPct / 100 * n;   // Lv7 → ×0.60, Lv5 → ×0.73
  return {
    timeSeconds: Math.round(seed.growthTime * timeMul),
    quantity:    Math.round(seed.harvestQuantity * yieldMul),
    value:       Math.round(seed.harvestQuantity * yieldMul * Number(seed.harvestValue)),
  };
}
```

实测对照（种子=七日彩莲 weekly_lotus，growthTime=604800s，harvestQuantity=100）：
- Lv7 地块：362880s ≈ 100.8 小时、产量 300 —— 与页面显示及种下后接口返回完全一致。
- Lv1 地块：整 7 天、产量 100。

## 2.1 ⚠️ 地块等级的唯一可靠来源：`yieldMultiplier`（2026-09-11 实测）

**结论：计算等级必须靠 `/api/farm/crops` 的 `yieldMultiplier`**，这是唯一权威路径：

- `unlockedPlotLevels`（plots 接口）字段与真实等级错位，不可信（实测 0–5 号地标 Lv1，实际 Lv7）。
- 换算公式：`level = Math.round((yieldMultiplier - 1) / (yieldPct/100)) + 1`（yieldPct 来自 mechanics 接口；Lv5 的 ym=2.3332 是截断值，用 round 容差）。
- 实测对照：ym=3 → Lv7，ym=2.3332 → Lv5，ym=1 → Lv1，与界面角标完全一致。
- **空地没有 yieldMultiplier**：脚本维护 `plotIndex → level` 缓存表，从已种作物初始化；空地种下第一株后用返回的权威值回填并长期缓存（等级只在升级时变）。空地在种前只能按 Lv1 保守预估，或标注「等级未知」。

## 3. 对账校准（防止网站改算法而脚本静默出错）

种下一株后，`GET /api/farm/crops` 返回该作物的权威值：

```json
{ "plotIndex": 0, "seedId": "weekly_lotus",
  "plantedAt": "…", "maturesAt": "2026-09-14T07:06:13.971Z",
  "remainingTime": 268701, "yieldMultiplier": 3 }
```

- `maturesAt` / `remainingTime`（秒）/ `yieldMultiplier` 都是**服务端算好**的最终值，展示层只是渲染。
- 脚本里断言：`yieldMultiplier` ≈ 估算的 yieldMul、`maturesAt-plantedAt` ≈ 估算的 timeSeconds。不一致时 console 警告「农场算法已变更，需更新脚本」。
- 注意：服务端对倍数可能做舍入（1+0.3333×6=2.9998 → 3），对账时留 ±1% 容差。

## 4. 种下去之后（无需计算）

直接读 `/api/farm/crops` 的 `maturesAt`、`remainingTime`、`yieldMultiplier`，不要自己再乘。

## 5. 参考数据：种子表快照（2026-09-11，勿硬编码，运行时从 /api/farm/seeds 拉）

growthTime(秒) | 名称 | 基础产量 | 单个售价 | 种子价格
--- | --- | --- | --- | ---
3600 | 胡萝卜 | 18 | 129,575 | 477,010
3600 | 番茄 | 32 | 72,886 | 477,010
5400 | 玉米 | 28 | 130,118 | 745,123
7200 | 南瓜 | 30 | 166,651 | 1,022,494
10800 | 蓝莓 | 32 | 244,050 | 1,597,207
14400 | 草莓 | 35 | 306,192 | 2,191,764
21600 | 西瓜 | 38 | 440,533 | 3,423,687
25200 | 芒果 | 40 | 495,842 | 4,056,351
28800 | 土豆/火龙果 | 40 | 574,294 / 775,297 | 4,698,148 / 6,342,500
39600 | 茄子 | 42 | 776,386 | 6,668,984
36000 | 杨桃 | 42 | 943,800 | 8,107,025
50400 | 辣椒 | 46 | 924,226 | 8,694,980
43200 | 榴莲 / 金苹果 | 60 / 30 | 807,378 / 1,614,757 | 9,907,427
61200 | 向日葵 | 50 | 1,052,735 | 10,765,186
68400 | 蜜桃 | 52 | 1,143,986 | 12,166,249
72000 | 黄金麦穗 | 52 | 1,210,389 | 12,872,435
54000 | 琥珀梨 | 48 | 1,289,995 | 12,663,737
64800 | 霜华梅 | 50 | 1,513,418 | 15,476,090
86400 | 翡翠卷心菜 / 玉露蓝玫瑰 | 55 | 1,398,508 / 1,887,986 | 15,731,136 / 21,237,034
108000 | 玛瑙豆 / 水晶葡萄 | 60 | 1,638,617 / 2,212,133 | 20,107,640 / 27,145,314
129600 | 白金芋 / 星尘莓 | 62 | 1,937,922 / 2,616,195 | 24,573,130 / 33,173,725
172800 | 月光花 | 65 | 3,424,373 | 45,522,579
216000 | 极光蜜瓜 | 70 | 4,064,409 | 58,187,255
259200 | 彩虹凤梨 | 75 | 4,635,894 | 71,109,437
388800 | 赤阳莲 | 85 | 6,389,638 | 111,077,891
604800 | 七日彩莲 | 100 | 8,830,174 | 180,593,330

## 6. 稳定性设计原则

1. 只写「线性加成」这一结构，所有可变数字（每级百分比、最大等级、种子数值）运行时从接口读。
2. 对字段做存在性检查：接口缺 `yieldPercentPerLevel` 等字段时降级提示，不输出错误预估。
3. 用第 3 节的对账做运行时自检，网站改算法结构时能主动报警。
