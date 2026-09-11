// ==UserScript==
// @name         农场最佳种植助手
// @namespace    hybgzs-farm-helper
// @version      0.5.0
// @description  算现在种什么更值（长期续种视角 + 贵种子省种子方案）
// @match        https://cdk.hybgzs.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const APP_CONFIG = Object.freeze({
    apiBaseUrl: "https://cdk.hybgzs.com/api/farm",
    marketPageLimit: 20,
    recyclePageSize: 8,
    coinScale: 500_000,
    panelId: "farm-best-crop-panel",
    styleId: "farm-best-crop-style",
    refreshButtonId: "farm-best-crop-refresh",
    rollingToggleButtonId: "farm-best-crop-rolling-toggle",
    toggleButtonId: "farm-best-crop-toggle",
    closeButtonId: "farm-best-crop-close",
    windowId: "farm-best-crop-window",
    dragHandleId: "farm-best-crop-drag-handle",
    storageKey: "farm-best-crop-window-state",
    marketFetchConcurrency: 4,
    rollingHorizonDays: 90,
    // 滚种比较只看前几轮：铺满目标作物后再收 targetRoundsAfterFull 轮即结算，
    // 避免 90 天长期口径掩盖「前期滚种赢、后期全买反超」的交叉。
    rollingTargetRoundsAfterFull: 2,
    rollingMaxEvents: 3000,
    rollingOvertakeEpsilon: 500_000, // 1 刀（原始币值），两方案期末净利差小于它视为"差不多"
    windowMargin: 16,
    defaultWindowWidth: 960,
    defaultWindowHeight: 720,
    minWindowWidth: 360,
    minWindowHeight: 320,
  });

  const STATUS_TEXT = Object.freeze({
    ok: "可买",
    marketEmpty: "菜场没货",
    marketEmptyOfficial: "菜场没货，种子价格按官方价算",
    marketError: "菜场失败",
    insufficientMarket: "数量不够",
    quoteFailed: "报价失败",
    noRecyclePrice: "无交易所价",
  });

  const LONG_TERM_SCORE_LABEL = "续种每小时利润（Lv1 基准）";
  const LONG_TERM_TITLE_TIP = "先看推荐，再看全表。按 Lv1 地上的续种每小时利润排。";
  const LONG_TERM_TABLE_TIP = "表里有全部信息，按 Lv1 地上的续种每小时利润从高到低排。";
  const LONG_TERM_FOOTNOTE =
    "续种每小时利润 = 留 1 个继续种之后，剩下收成按交易所价格卖出，再除以生长小时（按 Lv1 基准算，不含地块加成）。种子只在第一轮花钱，回本轮数越少越好，回本之后每一轮都是纯利润。全表里的「→最高级地」列是同一种子种在你现有最高级地上的表现，供参考。";
  const ROLLING_PLAN_FOOTNOTE =
    "省种子算法按 1 个果子 = 1 颗种子算，种子钱按菜场单颗价乘数量估（挂单不够买齐时实际更贵），过程中不补买种子。";

  const PLOT_UNLOCK_STATUS_TEXT = Object.freeze({
    ready: "现在可开",
    noNextUnlock: "地块已全部开完",
    unavailable: "还没拿到开地数据",
    levelLocked: "等级不够",
  });

  const REPLANT_KEEP_QUANTITY = 1;
  const AVAILABLE_STATUS_KEYS = Object.freeze(["ok", "marketEmptyOfficial"]);
  const ROLLING_PLAN_STATUS_TEXT = Object.freeze({
    noPlots: "拿不到地块总数（/crops 接口），这个功能用不了",
    noTarget: "现在没有值得种的品种，用不上",
    cannotSpread: "这个品种一次只结 1 个果子，没法自己留种繁殖，只能一次买齐",
    directBuy: "直接一次买齐就行，不用省这个钱",
    rolling: "先买 1 颗慢慢铺满，别一次买齐",
  });
  const state = {
    isLoading: false,
    error: "",
    warning: "",
    rows: [],
    plotSummary: null,
    recommendedRow: null,
    maxSlots: null,
    plotLevels: null, // Map plotIndex -> 等级（1..maxLevel），从 /crops 的 yieldMultiplier 反推（unlockedPlotLevels 实测错位不可用）
    rollingPlan: null,
    updatedAt: "",
  };
  const uiState = loadUiState();
  const quoteCache = new Map();
  let booted = false;
  let loadToken = 0;
  let resizeObserver = null;
  let dragState = null;

  const FARM_PATH_PREFIX = "/entertainment/farm";
  const MOUNT_CHECK_INTERVAL_MS = 500;

  function isFarmPageUrl() {
    return location.hostname === "cdk.hybgzs.com" && location.pathname.startsWith(FARM_PATH_PREFIX);
  }

  function bootstrap() {
    if (booted) {
      return;
    }
    booted = true;
    window.addEventListener("resize", handleViewportResize);
    window.addEventListener("pointermove", handleWindowDragMove);
    window.addEventListener("pointerup", handleWindowDragEnd);
    window.addEventListener("pointercancel", handleWindowDragEnd);
    ensureStyle();
    render();
    maybeLoadDataForOpenWindow();
  }

  // 站点是 Next.js SPA：脚本可能比 React 接管页面更早，插入的面板随后被整个清掉；
  // 也可能从站内其他页面经客户端路由第一次进入农场（Tampermonkey 不会重新注入）。
  // 用轮询兜底：时机成熟才启动；启动后面板一旦被页面框架移除，就重新挂载并渲染。
  function ensureMounted() {
    if (!isFarmPageUrl() || !document.body) {
      return;
    }
    if (!booted) {
      bootstrap();
      return;
    }
    if (!document.getElementById(APP_CONFIG.panelId)) {
      render();
    }
  }

  ensureMounted();
  window.setInterval(ensureMounted, MOUNT_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", ensureMounted);
  window.addEventListener("pageshow", ensureMounted);

  async function loadData() {
    const currentToken = ++loadToken;
    quoteCache.clear();
    state.isLoading = true;
    state.error = "";
    render();

    try {
      const snapshot = await collectSnapshot();
      if (currentToken !== loadToken) {
        return;
      }
      state.rows = snapshot.rows;
      state.plotSummary = snapshot.plotSummary;
      state.recommendedRow = snapshot.recommendedRow;
      state.maxSlots = snapshot.maxSlots;
      state.plotLevels = snapshot.plotLevels;
      state.rollingPlan = null; // 展开时才重新算
      state.updatedAt = formatTime(snapshot.updatedAt);
      state.error = "";
      state.warning = snapshot.warning ?? "";
    } catch (error) {
      if (currentToken !== loadToken) {
        return;
      }
      console.error("[farm-best-crop]", error);
      state.rows = [];
      state.plotSummary = null;
      state.recommendedRow = null;
      state.maxSlots = null;
      state.plotLevels = null;
      state.rollingPlan = null;
      state.updatedAt = "";
      state.error = toErrorMessage(error);
    } finally {
      if (currentToken !== loadToken) {
        return;
      }
      state.isLoading = false;
      render();
    }
  }

  function maybeLoadDataForOpenWindow() {
    if (!uiState.open || state.isLoading || state.updatedAt || state.error) {
      return;
    }
    void loadData();
  }

  async function collectSnapshot() {
    const [seeds, recyclePriceMap, plotsInfo, cropsInfo, mechanics] = await Promise.all([
      fetchSeeds(),
      fetchRecyclePriceMap(),
      fetchPlotsInfo().catch((error) => {
        console.warn("[farm-best-crop] plots", error);
        return null;
      }),
      fetchCropsInfo().catch((error) => {
        console.warn("[farm-best-crop] crops", error);
        return null;
      }),
      fetchMechanicsParams().catch((error) => {
        console.warn("[farm-best-crop] mechanics", error);
        return null;
      }),
    ]);

    const maxSlots = cropsInfo?.maxSlots ?? null;
    // 地块等级唯一可靠来源：/crops 的 yieldMultiplier 反推（详见 farm-estimate-guide.md §2.1）。
    // /plots 的 unlockedPlotLevels 实测与真实等级错位（2026-09-11），不可用。
    const plotLevels = mergePlotLevels(cropsInfo?.crops ?? [], mechanics, plotsInfo?.plotLevels ?? null);

    const marketMap = await fetchMarketMap(seeds);
    const rawRows = await mapWithConcurrency(seeds, APP_CONFIG.marketFetchConcurrency, async (seed) =>
      buildCropRow(seed, recyclePriceMap.get(seed.id) ?? null, marketMap.get(seed.id), plotsInfo?.nextUnlock ?? null, mechanics, plotLevels),
    );
    const updatedAt = Date.now();
    const rows = rawRows.map((row) => ({
      ...row,
      // 预计收菜时间按「该种子能种到的最高级地块」算，和推荐口径一致
      expectedHarvestAt: buildExpectedHarvestAt(updatedAt, row.bestGrowthSeconds ?? row.growthSeconds),
    }));
    const sortedRows = sortRows(rows);
    const plotSummary = buildPlotSummary(rows, plotsInfo);
    const recommendedRow = getRecommendedRow(sortedRows);
    const warning = reconcileEstimate(cropsInfo?.crops ?? [], plotLevels, mechanics);

    return {
      rows: sortedRows,
      plotSummary,
      recommendedRow,
      maxSlots,
      plotLevels,
      warning,
      updatedAt: new Date(updatedAt),
    };
  }

  // 跨会话内存缓存：空地没有 yieldMultiplier，靠上一轮已种作物回填。
  // 等级只在升级时变，缓存始终保留旧值，新作物返回权威值后更新。
  const plotLevelCache = new Map();

  function levelFromYieldMultiplier(yieldMultiplier, mechanics) {
    if (!mechanics || !mechanics.yieldPct) {
      return null;
    }
    // 服务端可能舍入（1+0.3333×6=2.9998→3），用 round 容差
    const level = Math.round((yieldMultiplier - 1) / (mechanics.yieldPct / 100)) + 1;
    if (!Number.isFinite(level) || level < 1 || level > mechanics.maxLevel) {
      return null;
    }
    return level;
  }

  function mergePlotLevels(crops, mechanics, fallbackLevels) {
    // 1) 先用上一轮缓存铺底（空地也能保留等级）
    const merged = new Map(plotLevelCache);
    // 2) 用本轮已种作物的权威 yieldMultiplier 覆盖/回填缓存
    for (const crop of crops) {
      const ym = toNullableNumber(crop.yieldMultiplier);
      if (ym === null || crop.plotIndex === undefined || crop.plotIndex === null) {
        continue;
      }
      const level = levelFromYieldMultiplier(ym, mechanics);
      if (level !== null) {
        merged.set(String(crop.plotIndex), level);
        plotLevelCache.set(String(crop.plotIndex), level);
      }
    }
    if (merged.size > 0) {
      return merged;
    }
    // 3) 无任何权威来源时才退回不可靠的 unlockedPlotLevels（聊胜于无）
    return fallbackLevels;
  }

  async function fetchSeeds() {
    const response = await requestJson("/seeds");
    return (response.seeds ?? [])
      .filter((seed) => seed && seed.isEnabled !== false)
      .map((seed) => ({
        id: String(seed.id),
        name: String(seed.name),
        officialSeedPrice: toNumber(seed.price),
        growthSeconds: toNumber(seed.growthTime),
        harvestQuantity: toNumber(seed.harvestQuantity),
        isVipOnly: Boolean(seed.isVipOnly),
      }));
  }

  async function fetchRecyclePriceMap() {
    const priceMap = new Map();
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await requestJson(
        `/recycle/prices?includeTrend=1&page=${page}&pageSize=${APP_CONFIG.recyclePageSize}&trendPoints=24`,
      );
      for (const item of response.data ?? []) {
        priceMap.set(String(item.seedId), toNumber(item.recyclePrice));
      }
      hasMore = Boolean(response.hasMore);
      page += 1;
    }

    return priceMap;
  }

  async function fetchPlotsInfo() {
    const response = await requestJson("/plots");
    return normalizePlotsInfo(response.data ?? null);
  }

  // 一次 GET 拿地块加成系数（静态配置，基本不变）；拿不到时全部按 Lv1 降级
  async function fetchMechanicsParams() {
    const response = await requestJson("/codex/mechanics");
    return normalizeMechanicsParams(response?.data ?? null);
  }

  function normalizeMechanicsParams(data) {
    const p = data?.params?.plots;
    if (!p || typeof p !== "object") {
      return null;
    }
    const maxLevel = toNullableNumber(p.upgradeMaxLevel);
    const yieldPct = toNullableNumber(p.yieldPercentPerLevel);
    const speedPct = toNullableNumber(p.growthSpeedPercentPerLevel);
    if (maxLevel === null || yieldPct === null || speedPct === null) {
      return null;
    }
    return { maxLevel, yieldPct, speedPct };
  }

  async function fetchCropsInfo() {
    const response = await requestJson("/crops");
    const maxSlots = toNullableNumber(response.maxSlots);
    if (!Number.isFinite(maxSlots)) {
      throw new Error("地块数字段缺失");
    }
    return {
      maxSlots: Math.max(0, Math.floor(maxSlots)),
      crops: Array.isArray(response.crops) ? response.crops : [],
    };
  }

  function normalizePlotsInfo(data) {
    if (!data || typeof data !== "object") {
      return null;
    }

    const levelsRaw = data.unlockedPlotLevels && typeof data.unlockedPlotLevels === "object" ? data.unlockedPlotLevels : null;
    const plotLevels = levelsRaw
      ? new Map(
          Object.entries(levelsRaw)
            .map(([index, level]) => [String(index), Math.floor(Number(level))])
            .filter(([index, level]) => index !== "" && Number.isFinite(level) && level >= 1),
        )
      : null;

    const nextUnlockRaw = data.nextUnlock && typeof data.nextUnlock === "object" ? data.nextUnlock : null;
    const vipPlotStartIndex = toNullableNumber(data.vipPlotStartIndex);
    const vipPlotEndIndex = toNullableNumber(data.vipPlotEndIndex);
    const nextUnlock = nextUnlockRaw
      ? {
          plotIndex: toNullableNumber(nextUnlockRaw.plotIndex),
          requiredLevel: toNullableNumber(nextUnlockRaw.requiredLevel),
          cost: toNullableNumber(nextUnlockRaw.cost),
          canUnlock: Boolean(nextUnlockRaw.canUnlock),
        }
      : null;

    return {
      nextUnlock,
      nextUnlockIsVip: nextUnlock ? isVipPlotIndex(nextUnlock.plotIndex, vipPlotStartIndex, vipPlotEndIndex) : false,
      vipPlotEndIndex,
      vipPlotStartIndex,
      plotLevels,
    };
  }

  async function fetchMarketMap(seeds) {
    const marketRows = await mapWithConcurrency(seeds, APP_CONFIG.marketFetchConcurrency, async (seed) => {
      try {
        const listings = await fetchAllMarketListings(seed.id);
        return [seed.id, { listings, error: "" }];
      } catch (error) {
        console.error("[farm-best-crop] market", seed.id, error);
        return [seed.id, { listings: [], error: toErrorMessage(error) }];
      }
    });

    return new Map(marketRows);
  }

  async function fetchAllMarketListings(seedId) {
    const listings = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await requestJson(
        `/market?page=${page}&limit=${APP_CONFIG.marketPageLimit}&seedId=${encodeURIComponent(seedId)}`,
      );
      for (const item of response.data ?? []) {
        listings.push({
          id: String(item.id),
          quantity: toNumber(item.quantity),
          pricePerUnit: toNumber(item.pricePerUnit),
          createdAt: String(item.createdAt ?? ""),
        });
      }
      hasNextPage = Boolean(response.pagination?.hasNextPage);
      page += 1;
    }

    return listings.sort(compareListings);
  }

  function compareListings(left, right) {
    if (left.pricePerUnit !== right.pricePerUnit) {
      return left.pricePerUnit - right.pricePerUnit;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.id.localeCompare(right.id);
  }

  async function buildCropRow(seed, recyclePrice, marketSnapshot, nextUnlock, mechanics, plotLevels) {
    const listings = marketSnapshot?.listings ?? [];
    const marketError = marketSnapshot?.error ?? "";
    const marketTotalQuantity = listings.reduce((sum, item) => sum + item.quantity, 0);
    const marketMinUnitPrice = listings.length > 0 ? listings[0].pricePerUnit : null;
    const buyOneResult =
      !marketError && listings.length === 0
        ? {
            status: "officialPrice",
            buyerPaysTotal: seed.officialSeedPrice,
          }
        : listings.length > 0
          ? await quotePurchase(listings, 1)
          : null;

    const buyOneTotal =
      buyOneResult?.status === "ok" || buyOneResult?.status === "officialPrice"
        ? buyOneResult.buyerPaysTotal
        : null;
    const roundSaleAmount = recyclePrice !== null ? seed.harvestQuantity * recyclePrice : null;
    const roundProfit =
      Number.isFinite(roundSaleAmount) && Number.isFinite(buyOneTotal)
        ? roundSaleAmount - buyOneTotal
        : null;
    const replantSaleQuantity = recyclePrice !== null ? Math.max(seed.harvestQuantity - REPLANT_KEEP_QUANTITY, 0) : null;
    const replantProfit = Number.isFinite(replantSaleQuantity) && recyclePrice !== null ? replantSaleQuantity * recyclePrice : null;
    const replantHourlyProfit =
      replantProfit !== null && seed.growthSeconds > 0 ? replantProfit / (seed.growthSeconds / 3600) : null;
    const hourlyProfit =
      roundProfit !== null && seed.growthSeconds > 0 ? roundProfit / (seed.growthSeconds / 3600) : null;

    // 地块加成：只信接口给的系数，没有就全部按 Lv1（不猜数字）。
    // best* = 种在现有最高级地上的值（拿种子最快、续种最赚），base* = Lv1 基准。
    const bestLevel = plotLevels && mechanics ? Math.max(...plotLevels.values()) : 1;
    const bestMul = mechanics && bestLevel > 1 ? buildPlotMultiplier(bestLevel, mechanics) : null;
    const bestGrowthSeconds = bestMul ? Math.round(seed.growthSeconds * bestMul.timeMul) : seed.growthSeconds;
    const bestQuantity = bestMul ? Math.max(1, Math.round(seed.harvestQuantity * bestMul.yieldMul)) : seed.harvestQuantity;
    const bestReplantProfit = bestMul && recyclePrice !== null ? Math.max(bestQuantity - REPLANT_KEEP_QUANTITY, 0) * recyclePrice : replantProfit;
    const bestReplantHourlyProfit =
      bestReplantProfit !== null && bestGrowthSeconds > 0 ? bestReplantProfit / (bestGrowthSeconds / 3600) : null;
    const bestReplantBreakEvenRounds = bestMul
      ? buildReplantBreakEvenRounds({ roundSaleAmount: bestQuantity * (recyclePrice ?? 0), replantProfit: bestReplantProfit, buyOneTotal })
      : replantBreakEvenRounds;
    const replantBreakEvenRounds = buildReplantBreakEvenRounds({
      roundSaleAmount,
      replantProfit,
      buyOneTotal,
    });
    const officialDiff = marketMinUnitPrice !== null ? seed.officialSeedPrice - marketMinUnitPrice : null;

    const status = resolveRowStatus({
      marketError,
      listings,
      recyclePrice,
      buyOneResult,
      marketTotalQuantity,
    });
    const row = {
      seedId: seed.id,
      name: seed.name,
      isVipOnly: seed.isVipOnly,
      growthSeconds: seed.growthSeconds,
      harvestQuantity: seed.harvestQuantity,
      officialSeedPrice: seed.officialSeedPrice,
      recyclePrice,
      marketMinUnitPrice,
      marketTotalQuantity,
      buyOneResult,
      buyOneTotal,
      roundSaleAmount,
      roundProfit,
      replantSaleQuantity,
      replantProfit,
      replantHourlyProfit,
      replantBreakEvenRounds,
      hourlyProfit,
      officialDiff,
      bestLevel,
      bestGrowthSeconds,
      bestQuantity,
      bestReplantProfit,
      bestReplantHourlyProfit,
      bestReplantBreakEvenRounds,
      bestYieldMul: bestMul ? bestMul.yieldMul : 1,
      bestTimeMul: bestMul ? bestMul.timeMul : 1,
      statusKey: status.key,
      statusText: status.text,
    };
    const plotBreakEven = buildPlotBreakEven(row, nextUnlock);

    return {
      ...row,
      ...plotBreakEven,
    };
  }

  function buildPlotMultiplier(level, mechanics) {
    const n = Math.max(0, level - 1);
    return {
      // 和指南公式一致：产量每级 +yieldPct%，时长每级 −speedPct%。
      // 服务端可能对倍数四舍五入（如 2.9998→3），对账时留 ±1% 容差。
      yieldMul: 1 + (mechanics.yieldPct / 100) * n,
      timeMul: 1 - (mechanics.speedPct / 100) * n,
    };
  }

  // 运行时对账：用服务端算好的 yieldMultiplier / maturesAt 反推，
  // 和本地公式比对，不一致说明网站改了算法，提示更新脚本。
  function reconcileEstimate(crops, plotLevels, mechanics) {
    if (!mechanics || !plotLevels || !Array.isArray(crops)) {
      return "";
    }
    for (const crop of crops) {
      const level = plotLevels.get(String(crop.plotIndex));
      if (!level) {
        continue;
      }
      const { yieldMul, timeMul } = buildPlotMultiplier(level, mechanics);
      const serverYield = toNullableNumber(crop.yieldMultiplier);
      const serverTime = toNullableNumber(crop.remainingTime);
      const plantedAt = Date.parse(crop.plantedAt ?? "");
      const maturesAt = Date.parse(crop.maturesAt ?? "");
      if (serverYield !== null && Math.abs(serverYield - yieldMul) / yieldMul > 0.01) {
        // 调试：把对账失败的全原始上下文打到控制台，方便复制反馈
        console.log("[farm-helper] 产量对账失败", {
          对账公式: `yieldMul = 1 + yieldPct/100 × (level-1)`,
          mechanics,
          本地计算: { level, yieldMul },
          本地plotLevels快照: [...plotLevels.entries()],
          服务端返回: {
            plotIndex: crop.plotIndex,
            yieldMultiplier: crop.yieldMultiplier,
            remainingTime: crop.remainingTime,
            plantedAt: crop.plantedAt,
            maturesAt: crop.maturesAt,
          },
          服务端完整crop对象: crop,
        });
        return `产量对不上（本算 ${yieldMul.toFixed(2)}，服务端 ${serverYield}），算法可能已改，请更新脚本`;
      }
      if (
        serverTime !== null &&
        Number.isFinite(plantedAt) &&
        Number.isFinite(maturesAt) &&
        Math.abs((maturesAt - Date.now()) / 1000 - serverTime) > 60
      ) {
        console.log("[farm-helper] 时长对账失败", {
          调试说明: "remainingTime 是剩余秒数（≈maturesAt−now），不是总时长",
          mechanics,
          本地计算: {
            level,
            timeMul,
            期望剩余: (maturesAt - Date.now()) / 1000,
            参考总时长: (maturesAt - plantedAt) / 1000,
          },
          服务端返回: {
            plotIndex: crop.plotIndex,
            remainingTime: crop.remainingTime,
            plantedAt: crop.plantedAt,
            maturesAt: crop.maturesAt,
          },
          服务端完整crop对象: crop,
        });
        return "时长字段对不上，请更新脚本";
      }
    }
    return "";
  }

  function buildReplantBreakEvenRounds(context) {
    const { roundSaleAmount, replantProfit, buyOneTotal } = context;
    if (!Number.isFinite(replantProfit) || !Number.isFinite(buyOneTotal)) {
      return null;
    }
    // 首轮收成全部卖出（还没种子可留），从第二轮开始才每轮留 1 个续种。
    const firstRoundProfit = Number.isFinite(roundSaleAmount) ? roundSaleAmount - buyOneTotal : null;
    if (!Number.isFinite(firstRoundProfit)) {
      return null;
    }
    if (firstRoundProfit >= 0) {
      return 1;
    }
    if (replantProfit <= 0) {
      return null;
    }
    return 1 + Math.ceil(-firstRoundProfit / replantProfit);
  }

  function buildPlotBreakEven(row, nextUnlock) {
    const unlockCost = nextUnlock?.cost;
    if (!Number.isFinite(unlockCost) || !isAvailableCropRow(row)) {
      return {
        plotBreakEvenRounds: null,
        plotBreakEvenSeconds: null,
      };
    }
    if (!Number.isFinite(row.replantProfit) || row.replantProfit <= 0 || row.growthSeconds <= 0) {
      return {
        plotBreakEvenRounds: null,
        plotBreakEvenSeconds: null,
      };
    }

    const rounds = Math.ceil(unlockCost / row.replantProfit);
    return {
      plotBreakEvenRounds: rounds,
      plotBreakEvenSeconds: rounds * row.growthSeconds,
    };
  }

  function resolveRowStatus(context) {
    if (context.marketError) {
      return { key: "marketError", text: STATUS_TEXT.marketError };
    }
    if (context.buyOneResult?.status === "quoteFailed") {
      return { key: "quoteFailed", text: STATUS_TEXT.quoteFailed };
    }
    if (context.buyOneResult?.status === "insufficient") {
      return {
        key: "insufficientMarket",
        text: `${STATUS_TEXT.insufficientMarket}(${context.marketTotalQuantity})`,
      };
    }
    if (context.recyclePrice === null) {
      return { key: "noRecyclePrice", text: STATUS_TEXT.noRecyclePrice };
    }
    if (context.buyOneResult?.status === "officialPrice") {
      return { key: "marketEmptyOfficial", text: STATUS_TEXT.marketEmptyOfficial };
    }
    if (context.listings.length === 0) {
      return { key: "marketEmpty", text: STATUS_TEXT.marketEmpty };
    }
    return { key: "ok", text: STATUS_TEXT.ok };
  }

  function buildPurchasePlan(listings, targetQuantity) {
    const items = [];
    let remainingQuantity = targetQuantity;
    let availableQuantity = 0;

    for (const listing of listings) {
      const listingQuantity = Math.max(0, listing.quantity);
      availableQuantity += listingQuantity;
      if (remainingQuantity <= 0 || listingQuantity === 0) {
        continue;
      }
      const quantityToBuy = Math.min(remainingQuantity, listingQuantity);
      items.push({ listing, quantity: quantityToBuy });
      remainingQuantity -= quantityToBuy;
    }

    return {
      items,
      availableQuantity,
      enough: remainingQuantity === 0,
    };
  }

  async function quotePurchase(listings, targetQuantity) {
    const purchasePlan = buildPurchasePlan(listings, targetQuantity);
    if (!purchasePlan.enough) {
      return {
        status: "insufficient",
        targetQuantity,
        availableQuantity: purchasePlan.availableQuantity,
      };
    }

    try {
      let buyerPaysTotal = 0;
      let taxAmount = 0;
      let totalPrice = 0;

      // Buy from the cheapest listings first to mirror the real entry cost.
      for (const item of purchasePlan.items) {
        const quote = await fetchQuote(item.listing.id, item.quantity);
        buyerPaysTotal += quote.buyerPaysTotal;
        taxAmount += quote.taxAmount;
        totalPrice += quote.totalPrice;
      }

      return {
        status: "ok",
        targetQuantity,
        buyerPaysTotal,
        taxAmount,
        totalPrice,
      };
    } catch (error) {
      console.error("[farm-best-crop] quote", error);
      return {
        status: "quoteFailed",
        targetQuantity,
        errorMessage: toErrorMessage(error),
      };
    }
  }

  function fetchQuote(listingId, quantity) {
    const cacheKey = `${listingId}:${quantity}`;
    if (!quoteCache.has(cacheKey)) {
      const pendingQuote = requestJson("/market/quote", {
        method: "POST",
        body: { listingId, quantity },
      }).then((response) => ({
        totalPrice: toNumber(response.data?.totalPrice),
        taxAmount: toNumber(response.data?.taxAmount),
        buyerPaysTotal: toNumber(response.data?.buyerPaysTotal),
      }));
      quoteCache.set(cacheKey, pendingQuote);
    }
    return quoteCache.get(cacheKey);
  }

  async function requestJson(path, options = {}) {
    const requestUrl = path.startsWith("http") ? path : `${APP_CONFIG.apiBaseUrl}${path}`;
    const requestOptions = {
      method: options.method ?? "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    };

    if (options.body !== undefined) {
      requestOptions.headers["Content-Type"] = "application/json";
      requestOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(requestUrl, requestOptions);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (payload && payload.success === false) {
      throw new Error(payload.message || "接口失败");
    }
    return payload;
  }

  function sortRows(rows) {
    return [...rows].sort(compareRowsByProfitTab);
  }

  function compareRowsByProfitTab(left, right) {
    const replantHourlyDiff = compareFiniteDesc(left.replantHourlyProfit, right.replantHourlyProfit);
    if (replantHourlyDiff !== 0) {
      return replantHourlyDiff;
    }

    const replantProfitDiff = compareFiniteDesc(left.replantProfit, right.replantProfit);
    if (replantProfitDiff !== 0) {
      return replantProfitDiff;
    }

    const costDiff = compareFiniteAsc(left.buyOneTotal, right.buyOneTotal);
    if (costDiff !== 0) {
      return costDiff;
    }

    return left.name.localeCompare(right.name, "zh-CN");
  }

  function getRecommendedRow(rows) {
    return rows.find((row) => isRecommendedCandidate(row)) ?? null;
  }

  function isRecommendedCandidate(row) {
    return isAvailableCropRow(row) && Number.isFinite(row.replantHourlyProfit);
  }

  function getRecommendationMetricText(row) {
    return formatCoin(row.replantHourlyProfit);
  }

  function isAvailableCropRow(row) {
    return AVAILABLE_STATUS_KEYS.includes(row.statusKey);
  }

  // ---------- 开荒计划（滚种模拟） ----------
  //
  // 场景：目标品种 X 续种利润最高但种子贵；先只买 k 颗 X，其余地块种首轮利润
  // 最高的过渡品种 Y；X 的富余收成当种子去把 Y 地逐轮换成 X，Y 收成直接卖。
  // 对 k = 1..N（k=N 即全买方案）逐个事件驱动模拟，比 90 天期末净利，选最优 k。

  function buildRollingPlan(rows, maxSlots) {
    const plotCount = Number.isFinite(maxSlots) ? Math.floor(maxSlots) : null;
    if (!Number.isFinite(plotCount) || plotCount < 1) {
      return { statusKey: "noPlots" };
    }

    const target = rows.find(isRecommendedCandidate) ?? null;
    if (!target || !isRollingCropUsable(target)) {
      return { statusKey: "noTarget", plotCount };
    }
    if (target.harvestQuantity < 2) {
      return { statusKey: "cannotSpread", plotCount, target };
    }

    const transition = rows
      .filter((row) =>
        isAvailableCropRow(row) &&
        row.seedId !== target.seedId &&
        isRollingCropUsable(row) &&
        Number.isFinite(row.replantHourlyProfit),
      )
      .sort((left, right) => right.replantHourlyProfit - left.replantHourlyProfit)[0] ?? null;

    if (!transition) {
      return {
        statusKey: "directBuy",
        plotCount,
        target,
        reasonText: "没有别的品种好过渡，直接一次买齐「" + target.name + "」。",
      };
    }

    const simulations = [];
    for (let initialXPlots = 1; initialXPlots <= plotCount; initialXPlots += 1) {
      simulations.push(
        simulateRollingSeeding({
          plotCount,
          initialXPlots,
          target,
          transition,
        }),
      );
    }

    const allBuySim = simulations[simulations.length - 1];
    let bestIndex = simulations.length - 1;
    for (let index = 0; index < simulations.length; index += 1) {
      const candidate = simulations[index];
      if (candidate.finalNet > simulations[bestIndex].finalNet + APP_CONFIG.rollingOvertakeEpsilon) {
        bestIndex = index;
      }
    }

    const bestSim = simulations[bestIndex];
    const finalDelta = bestSim.finalNet - allBuySim.finalNet;
    if (bestIndex >= simulations.length - 1 || finalDelta <= APP_CONFIG.rollingOvertakeEpsilon) {
      const almostEqual = Math.abs(finalDelta) <= APP_CONFIG.rollingOvertakeEpsilon;
      return {
        statusKey: "directBuy",
        plotCount,
        target,
        transition,
        finalDelta,
        reasonText: almostEqual
          ? "算下来两种种法差不多（相差 " + formatCoin(Math.abs(finalDelta)) +
            "，不到阈值 " + formatCoin(APP_CONFIG.rollingOvertakeEpsilon) + "），直接一次买齐省事。"
          : "算下来直接一次买齐更划算：" + formatRollingHorizonLabel() + "下来能多赚 " +
            formatCoin(Math.abs(finalDelta)) + "，省种子钱省不过赚的差价。",
      };
    }

    return {
      statusKey: "rolling",
      plotCount,
      target,
      transition,
      initialXPlots: bestIndex + 1,
      upfrontCostRolling: bestSim.seedCost,
      upfrontCostAllBuy: allBuySim.seedCost,
      fullXSeconds: bestSim.fullXAt !== null ? bestSim.fullXAt / 1000 : null,
      fullXRounds:
        bestSim.fullXAt !== null ? bestSim.fullXAt / 1000 / target.bestGrowthSeconds : null,
      overtakeText: buildOvertakeText(bestSim.curve, allBuySim.curve),
      scopeNote: "注意：这里的比较只覆盖前期（铺满「" + target.name + "」后约 " +
        APP_CONFIG.rollingTargetRoundsAfterFull + " 轮），不代表长期账。",
      finalDelta,
      horizonDays: APP_CONFIG.rollingHorizonDays,
    };
  }

  function formatRollingHorizonLabel() {
    return "" + APP_CONFIG.rollingHorizonDays + " 天";
  }

  function isRollingCropUsable(row) {
    return (
      isAvailableCropRow(row) &&
      Number.isFinite(row.buyOneTotal) &&
      Number.isFinite(row.recyclePrice) &&
      Number.isFinite(row.harvestQuantity) &&
      row.harvestQuantity >= 1 &&
      Number.isFinite(row.growthSeconds) &&
      row.growthSeconds > 0
    );
  }
  // 结算点 = 全部地块铺满目标作物后，再收 targetRoundsAfterFull 轮目标作物。
  // 铺满时间拿不到时（理论上不会发生），退回 rollingHorizonDays 时间上限。
  function buildRollingDeadlineMs(fullXAt, target) {
    if (fullXAt === null || !Number.isFinite(target.bestGrowthSeconds)) {
      return APP_CONFIG.rollingHorizonDays * 24 * 3600 * 1000;
    }
    return fullXAt + APP_CONFIG.rollingTargetRoundsAfterFull * target.bestGrowthSeconds * 1000;
  }

  function simulateRollingSeeding({ plotCount, initialXPlots, target, transition }) {
    // 口径：第一颗 X 种在现有最高级田上，收获最快、产量最高，扩散速度按
    // bestGrowthSeconds / bestQuantity 算；其余田种的过渡作物 Y 按 Lv1 基准算。
    const growthMs = {
      x: target.bestGrowthSeconds * 1000,
      y: transition.growthSeconds * 1000,
    };
    const harvestQty = {
      x: Math.max(1, Math.floor(target.bestQuantity)),
      y: Math.max(1, Math.floor(transition.harvestQuantity)),
    };
    const unitPrice = {
      x: target.recyclePrice,
      y: transition.recyclePrice,
    };
    const seedCost =
      initialXPlots * target.buyOneTotal + (plotCount - initialXPlots) * transition.buyOneTotal;

    // 地块状态：cropId 为 null 表示空着等种子。曾经的 X 地不允许改种 Y
    // （X 是利润主力，空等下一批 X 种子也比占着种 Y 强），只有原 Y 地才回种 Y。
    const plots = [];
    for (let index = 0; index < plotCount; index += 1) {
      const isTarget = index < initialXPlots;
      plots.push({
        cropId: isTarget ? "x" : "y",
        wasTarget: isTarget,
        matureAt: growthMs[isTarget ? "x" : "y"],
      });
    }

    const stock = { x: 0, y: 0 };
    let net = -seedCost;
    let fullXAt = null;
    let eventCount = 0;
    const curve = [{ at: 0, net }];

    while (eventCount < APP_CONFIG.rollingMaxEvents) {
      let now = Infinity;
      for (const plot of plots) {
        if (plot.matureAt < now) {
          now = plot.matureAt;
        }
      }
      const deadlineMs = buildRollingDeadlineMs(fullXAt, target);
      if (!Number.isFinite(now) || now > deadlineMs) {
        break;
      }
      eventCount += 1;

      const freedTargetPlots = [];
      for (const plot of plots) {
        if (plot.matureAt <= now) {
          stock[plot.cropId] += harvestQty[plot.cropId];
          plot.cropId = null;
          if (plot.wasTarget) {
            freedTargetPlots.push(plot);
          }
        }
      }

      // 先把 X 铺满空地（含刚收的 X 地自续），不够的空地用 Y 顶上，
      // 剩余 Y 种子直接卖掉；X 种子库存留给后面解放出来的 Y 地。
      for (const plot of plots) {
        if (plot.cropId === null && stock.x > 0) {
          plot.cropId = "x";
          stock.x -= 1;
          plot.matureAt = now + growthMs.x;
        }
      }
      for (const plot of plots) {
        if (plot.cropId === null && !plot.wasTarget && stock.y > 0) {
          plot.cropId = "y";
          stock.y -= 1;
          plot.matureAt = now + growthMs.y;
        }
      }
      net += stock.y * unitPrice.y;
      stock.y = 0;

      if (fullXAt === null && plots.every((plot) => plot.cropId === "x")) {
        fullXAt = now;
      }
      curve.push({ at: now, net });

      // 兜底：若所有 X 地都在等种子且再无事件，退出（正常不会发生，h>=2 保证自续）
      if (freedTargetPlots.length > 0 && freedTargetPlots.every((plot) => plot.cropId === null)) {
        const anyBusy = plots.some((plot) => plot.matureAt > now);
        if (!anyBusy && stock.x === 0) {
          break;
        }
      }
    }

    net += stock.x * unitPrice.x; // 期末清算剩余 X 种子
    return {
      seedCost,
      finalNet: net,
      fullXAt,
      curve,
    };
  }

  function buildOvertakeText(rollingCurve, allBuyCurve) {
    const epsilon = APP_CONFIG.rollingOvertakeEpsilon;
    const times = new Set();
    for (const point of rollingCurve) times.add(point.at);
    for (const point of allBuyCurve) times.add(point.at);
    const sortedTimes = [...times].sort((left, right) => left - right);

    const readNet = (curve, time) => {
      let low = 0;
      let high = curve.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (curve[mid].at <= time) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      return curve[low].net;
    };

    let everBehind = false;
    let everAhead = false;
    let overtakeAt = null;
    for (const time of sortedTimes) {
      const delta = readNet(rollingCurve, time) - readNet(allBuyCurve, time);
      if (delta < -epsilon) {
        everBehind = true;
      }
      if (delta > epsilon) {
        if (everBehind && overtakeAt === null) {
          overtakeAt = time;
        }
        everAhead = true;
      }
    }

    if (everBehind && overtakeAt !== null) {
      return "刚开始会比一次买齐少赚一点，大约 " + formatDuration(overtakeAt / 1000) + " 之后就开始反超，越往后赚得越多。";
    }
    if (everAhead) {
      return "每天都对过账：这么种，累计赚的钱从第一天到最后一天，一直都比一次买齐多。";
    }
    return "" + formatRollingHorizonLabel() + "的总账是更赚的，但中间有一阵子不如一次买齐。";
  }

  function buildPlotSummary(rows, plotsInfo) {
    if (!plotsInfo) {
      return {
        bestRow: null,
        nextUnlock: null,
        nextUnlockIsVip: false,
        statusText: PLOT_UNLOCK_STATUS_TEXT.unavailable,
      };
    }

    return {
      bestRow: getBestPlotBreakEvenRow(rows),
      nextUnlock: plotsInfo.nextUnlock,
      nextUnlockIsVip: plotsInfo.nextUnlockIsVip,
      statusText: getPlotUnlockStatusText(plotsInfo.nextUnlock),
    };
  }

  function getBestPlotBreakEvenRow(rows) {
    return rows
      .filter((row) => isAvailableCropRow(row) && Number.isFinite(row.plotBreakEvenSeconds))
      .sort(compareRowsByPlotBreakEven)[0] ?? null;
  }

  function compareRowsByPlotBreakEven(left, right) {
    const secondDiff = compareFiniteAsc(left.plotBreakEvenSeconds, right.plotBreakEvenSeconds);
    if (secondDiff !== 0) {
      return secondDiff;
    }

    const roundDiff = compareFiniteAsc(left.plotBreakEvenRounds, right.plotBreakEvenRounds);
    if (roundDiff !== 0) {
      return roundDiff;
    }

    const replantProfitDiff = compareFiniteDesc(left.replantProfit, right.replantProfit);
    if (replantProfitDiff !== 0) {
      return replantProfitDiff;
    }

    return left.name.localeCompare(right.name, "zh-CN");
  }

  function getPlotUnlockStatusText(nextUnlock) {
    if (!nextUnlock) {
      return PLOT_UNLOCK_STATUS_TEXT.noNextUnlock;
    }
    if (nextUnlock.canUnlock) {
      return PLOT_UNLOCK_STATUS_TEXT.ready;
    }
    if (Number.isFinite(nextUnlock.requiredLevel)) {
      return `${nextUnlock.requiredLevel}级可开`;
    }
    return PLOT_UNLOCK_STATUS_TEXT.levelLocked;
  }

  function isVipPlotIndex(plotIndex, vipPlotStartIndex, vipPlotEndIndex) {
    if (!Number.isFinite(plotIndex) || !Number.isFinite(vipPlotStartIndex) || !Number.isFinite(vipPlotEndIndex)) {
      return false;
    }
    return plotIndex >= vipPlotStartIndex && plotIndex <= vipPlotEndIndex;
  }

  function buildExpectedHarvestAt(updatedAt, growthSeconds) {
    if (!Number.isFinite(updatedAt) || !Number.isFinite(growthSeconds)) {
      return null;
    }
    return updatedAt + growthSeconds * 1000;
  }

  function compareFiniteDesc(left, right) {
    const leftValue = Number.isFinite(left) ? left : Number.NEGATIVE_INFINITY;
    const rightValue = Number.isFinite(right) ? right : Number.NEGATIVE_INFINITY;
    if (leftValue === rightValue) {
      return 0;
    }
    return rightValue - leftValue;
  }

  function compareFiniteAsc(left, right) {
    const leftValue = Number.isFinite(left) ? left : Number.POSITIVE_INFINITY;
    const rightValue = Number.isFinite(right) ? right : Number.POSITIVE_INFINITY;
    if (leftValue === rightValue) {
      return 0;
    }
    return leftValue - rightValue;
  }

  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function consume() {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, consume);
    await Promise.all(workers);
    return results;
  }

  function loadUiState() {
    const defaultState = createDefaultWindowState();

    try {
      const rawValue = localStorage.getItem(APP_CONFIG.storageKey);
      if (!rawValue) {
        return defaultState;
      }
      const parsedValue = JSON.parse(rawValue);
      return normalizeUiState({
        ...defaultState,
        ...parsedValue,
      });
    } catch (error) {
      console.warn("[farm-best-crop] window-state", error);
      return defaultState;
    }
  }

  function createDefaultWindowState() {
    const width = Math.min(APP_CONFIG.defaultWindowWidth, getAvailableWindowWidth());
    const height = Math.min(APP_CONFIG.defaultWindowHeight, getAvailableWindowHeight());
    const left = Math.max(APP_CONFIG.windowMargin, window.innerWidth - width - APP_CONFIG.windowMargin);
    const top = Math.max(APP_CONFIG.windowMargin, window.innerHeight - height - 88);

    return {
      open: false,
      left,
      top,
      width,
      height,
    };
  }

  function normalizeUiState(nextState) {
    const defaultState = createDefaultWindowState();
    const width = clamp(
      toFiniteNumber(nextState.width, defaultState.width),
      APP_CONFIG.minWindowWidth,
      getAvailableWindowWidth(),
    );
    const height = clamp(
      toFiniteNumber(nextState.height, defaultState.height),
      APP_CONFIG.minWindowHeight,
      getAvailableWindowHeight(),
    );
    const maxLeft = Math.max(APP_CONFIG.windowMargin, window.innerWidth - width - APP_CONFIG.windowMargin);
    const maxTop = Math.max(APP_CONFIG.windowMargin, window.innerHeight - height - APP_CONFIG.windowMargin);

    return {
      open: Boolean(nextState.open),
      left: clamp(toFiniteNumber(nextState.left, defaultState.left), APP_CONFIG.windowMargin, maxLeft),
      top: clamp(toFiniteNumber(nextState.top, defaultState.top), APP_CONFIG.windowMargin, maxTop),
      width,
      height,
    };
  }

  function setUiState(nextPartial, persist = false) {
    const normalizedState = normalizeUiState({
      ...uiState,
      ...nextPartial,
    });
    Object.assign(uiState, normalizedState);
    if (persist) {
      saveUiState();
    }
    return normalizedState;
  }

  function saveUiState() {
    try {
      localStorage.setItem(APP_CONFIG.storageKey, JSON.stringify(uiState));
    } catch (error) {
      console.warn("[farm-best-crop] save-window-state", error);
    }
  }

  function getAvailableWindowWidth() {
    return Math.max(APP_CONFIG.minWindowWidth, window.innerWidth - APP_CONFIG.windowMargin * 2);
  }

  function getAvailableWindowHeight() {
    return Math.max(APP_CONFIG.minWindowHeight, window.innerHeight - APP_CONFIG.windowMargin * 2);
  }

  function buildWindowStyle() {
    return [
      `left:${uiState.left}px`,
      `top:${uiState.top}px`,
      `width:${uiState.width}px`,
      `height:${uiState.height}px`,
    ].join(";");
  }

  function applyWindowStyle(windowElement) {
    if (!windowElement) {
      return;
    }
    windowElement.style.left = `${uiState.left}px`;
    windowElement.style.top = `${uiState.top}px`;
    windowElement.style.width = `${uiState.width}px`;
    windowElement.style.height = `${uiState.height}px`;
  }

  function handleViewportResize() {
    setUiState({}, true);
    applyWindowStyle(document.getElementById(APP_CONFIG.windowId));
  }

  function syncWindowRectFromElement(windowElement, persist = false) {
    if (!windowElement) {
      return;
    }

    const rect = windowElement.getBoundingClientRect();
    const previousRect = {
      left: uiState.left,
      top: uiState.top,
      width: uiState.width,
      height: uiState.height,
    };

    const normalizedState = setUiState(
      {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      persist,
    );

    if (
      normalizedState.left !== previousRect.left ||
      normalizedState.top !== previousRect.top ||
      normalizedState.width !== previousRect.width ||
      normalizedState.height !== previousRect.height
    ) {
      applyWindowStyle(windowElement);
    }
  }

  function startWindowDrag(event, windowElement) {
    if (!uiState.open || !windowElement) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }

    const rect = windowElement.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    windowElement.classList.add("is-dragging");
    document.body.style.userSelect = "none";
    event.preventDefault();
  }

  function handleWindowDragMove(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    setUiState(
      {
        left: event.clientX - dragState.offsetX,
        top: event.clientY - dragState.offsetY,
      },
      false,
    );
    applyWindowStyle(document.getElementById(APP_CONFIG.windowId));
  }

  function handleWindowDragEnd(event) {
    if (!dragState) {
      return;
    }
    if (event.pointerId !== undefined && dragState.pointerId !== event.pointerId) {
      return;
    }

    const windowElement = document.getElementById(APP_CONFIG.windowId);
    if (windowElement) {
      windowElement.classList.remove("is-dragging");
      syncWindowRectFromElement(windowElement, true);
    } else {
      saveUiState();
    }

    dragState = null;
    document.body.style.userSelect = "";
  }

  function render() {
    const panel = ensurePanel();
    panel.innerHTML = buildPanelHtml();

    const toggleButton = panel.querySelector(`#${APP_CONFIG.toggleButtonId}`);
    if (toggleButton) {
      toggleButton.addEventListener("click", () => {
        const nextOpen = !uiState.open;
        setUiState({ open: nextOpen }, true);
        if (nextOpen) {
          maybeLoadDataForOpenWindow();
        }
        render();
      });
    }

    const refreshButton = panel.querySelector(`#${APP_CONFIG.refreshButtonId}`);
    if (refreshButton) {
      refreshButton.addEventListener("click", () => {
        if (!state.isLoading) {
          void loadData();
        }
      });
    }

    const rollingToggleButton = panel.querySelector(`#${APP_CONFIG.rollingToggleButtonId}`);
    if (rollingToggleButton) {
      rollingToggleButton.addEventListener("click", () => {
        rollingExpanded = !rollingExpanded;
        render();
      });
    }

    const closeButton = panel.querySelector(`#${APP_CONFIG.closeButtonId}`);
    if (closeButton) {
      closeButton.addEventListener("click", () => {
        setUiState({ open: false }, true);
        render();
      });
    }

    const windowElement = panel.querySelector(`#${APP_CONFIG.windowId}`);
    applyWindowStyle(windowElement);

    const dragHandle = panel.querySelector(`#${APP_CONFIG.dragHandleId}`);
    if (dragHandle && windowElement) {
      dragHandle.addEventListener("pointerdown", (event) => {
        startWindowDrag(event, windowElement);
      });
    }

    if (windowElement) {
      windowElement.addEventListener("mouseup", () => {
        syncWindowRectFromElement(windowElement, true);
      });
    }

    observeWindowResize(windowElement);
  }

  function ensurePanel() {
    let panel = document.getElementById(APP_CONFIG.panelId);
    if (panel) {
      return panel;
    }

    panel = document.createElement("section");
    panel.id = APP_CONFIG.panelId;
    panel.setAttribute("aria-live", "polite");
    document.body.appendChild(panel);
    return panel;
  }

  function observeWindowResize(windowElement) {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    if (!windowElement || !uiState.open || typeof ResizeObserver === "undefined") {
      return;
    }

    resizeObserver = new ResizeObserver(() => {
      syncWindowRectFromElement(windowElement, true);
    });
    resizeObserver.observe(windowElement);
  }

  function ensureStyle() {
    if (document.getElementById(APP_CONFIG.styleId)) {
      return;
    }

    const style = document.createElement("style");
    style.id = APP_CONFIG.styleId;
    style.textContent = `
      #${APP_CONFIG.panelId} {
        position: fixed;
        inset: 0;
        z-index: 999999;
        pointer-events: none;
        color: #17321a;
        font-family: "Nunito Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      #${APP_CONFIG.panelId} * {
        box-sizing: border-box;
      }

      .farm-helper-launcher {
        pointer-events: auto;
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        background: linear-gradient(135deg, #4f7a3a, #85af63);
        color: #fff;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 16px 34px rgba(43, 68, 34, 0.28);
      }

      .farm-helper-window {
        pointer-events: auto;
        position: fixed;
        min-width: ${APP_CONFIG.minWindowWidth}px;
        min-height: ${APP_CONFIG.minWindowHeight}px;
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(86, 126, 77, 0.24);
        border-radius: 20px;
        background:
          radial-gradient(circle at top left, rgba(222, 245, 207, 0.96), rgba(247, 252, 242, 0.94) 52%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(242, 248, 236, 0.94));
        box-shadow: 0 18px 48px rgba(35, 56, 28, 0.18);
        backdrop-filter: blur(10px);
        resize: both;
        overflow: hidden;
      }

      .farm-helper-window.is-hidden {
        display: none;
      }

      .farm-helper-window.is-dragging {
        cursor: move;
      }

      .farm-helper-window-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(101, 131, 83, 0.12);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.6), rgba(236, 246, 228, 0.6));
        cursor: move;
        user-select: none;
        touch-action: none;
      }

      .farm-helper-window-title {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .farm-helper-window-title strong {
        font-size: 18px;
        line-height: 1.1;
      }

      .farm-helper-window-title span {
        color: #52714f;
        font-size: 12px;
      }

      .farm-helper-window-actions {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .farm-helper-window-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
      }

      .farm-helper-card {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-height: 100%;
        padding: 16px;
        background: transparent;
      }

      .farm-helper-time {
        color: #6f8570;
        font-size: 12px;
      }

      .farm-helper-button {
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        background: linear-gradient(135deg, #5b8b45, #88b36d);
        color: #fff;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }

      .farm-helper-close-button {
        background: rgba(100, 124, 83, 0.12);
        color: #35502a;
      }

      .farm-helper-button[disabled] {
        cursor: wait;
        opacity: 0.72;
      }

      .farm-helper-section {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-height: 0;
      }

      .farm-helper-tab-panel {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(104, 137, 91, 0.12);
      }

      .farm-helper-tab-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .farm-helper-tab-button {
        border: 1px solid rgba(91, 139, 69, 0.2);
        border-radius: 999px;
        padding: 9px 14px;
        background: rgba(255, 255, 255, 0.9);
        color: #35502a;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }

      .farm-helper-tab-button.is-active {
        border-color: transparent;
        background: linear-gradient(135deg, #5b8b45, #88b36d);
        color: #fff;
        box-shadow: 0 10px 22px rgba(55, 87, 41, 0.18);
      }

      .farm-helper-tab-desc {
        color: #4f6b47;
        font-size: 13px;
      }

      .farm-helper-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .farm-helper-section-head h3 {
        margin: 0;
        font-size: 15px;
      }

      .farm-helper-tip {
        color: #6f8570;
        font-size: 12px;
      }

      .farm-helper-recommend {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 16px;
        border-radius: 18px;
        background: linear-gradient(145deg, rgba(243, 250, 228, 0.98), rgba(255, 252, 240, 0.98));
        border: 1px solid rgba(111, 146, 89, 0.18);
      }

      .farm-helper-recommend.plot-unlock {
        background: linear-gradient(145deg, rgba(236, 247, 255, 0.98), rgba(244, 252, 247, 0.98));
        border-color: rgba(98, 141, 122, 0.18);
      }

      .farm-helper-hero {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
      }

      .farm-helper-name {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 6px;
      }

      .farm-helper-name strong {
        font-size: 24px;
        line-height: 1;
      }

      .farm-helper-pill {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(78, 112, 62, 0.12);
        color: #44623a;
        font-size: 11px;
        font-weight: 700;
      }

      .farm-helper-pill.vip {
        background: rgba(197, 160, 44, 0.16);
        color: #8a6400;
      }

      .farm-helper-score {
        min-width: 150px;
        padding: 12px;
        border-radius: 16px;
        background: rgba(83, 126, 66, 0.08);
        text-align: right;
      }

      .farm-helper-score span {
        display: block;
        color: #5e7757;
        font-size: 12px;
      }

      .farm-helper-score strong {
        display: block;
        margin-top: 6px;
        font-size: 26px;
        line-height: 1;
      }

      .farm-helper-metrics {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }

      .farm-helper-metric {
        padding: 12px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(104, 137, 91, 0.1);
      }

      .farm-helper-metric span {
        display: block;
        color: #68855f;
        font-size: 11px;
        margin-bottom: 6px;
      }

      .farm-helper-metric strong {
        display: block;
        font-size: 15px;
      }

      .farm-helper-state,
      .farm-helper-error,
      .farm-helper-empty {
        padding: 14px 16px;
        border-radius: 14px;
        font-size: 14px;
      }

      .farm-helper-state {
        background: rgba(89, 127, 70, 0.08);
        color: #476244;
      }

      .farm-helper-error {
        background: rgba(201, 79, 79, 0.1);
        color: #8c2e2e;
      }

      .farm-helper-empty {
        background: rgba(112, 128, 87, 0.08);
        color: #607157;
      }

      .farm-helper-table-wrap {
        overflow: auto;
        border-radius: 16px;
        border: 1px solid rgba(111, 146, 89, 0.14);
        background: rgba(255, 255, 255, 0.82);
      }

      .farm-helper-table {
        width: 100%;
        border-collapse: collapse;
        min-width: 1520px;
        font-size: 12px;
      }

      .farm-helper-table thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 10px 8px;
        background: #edf6e9;
        color: #4f6b47;
        text-align: left;
        white-space: nowrap;
      }

      .farm-helper-table tbody td {
        padding: 9px 8px;
        border-top: 1px solid rgba(101, 131, 83, 0.08);
        white-space: nowrap;
      }

      .farm-helper-table-value {
        font-weight: 700;
      }

      .farm-helper-table-value.good {
        color: #1e7a3d;
      }

      .farm-helper-table-value.bad {
        color: #b23a3a;
      }

      .farm-helper-table tbody tr:nth-child(odd) {
        background: rgba(249, 252, 245, 0.76);
      }

      .farm-helper-table tbody tr.is-dim {
        color: #72836d;
      }

      .farm-helper-status {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
      }

      .farm-helper-status.ok {
        background: rgba(65, 137, 83, 0.14);
        color: #1f6e33;
      }

      .farm-helper-status.warn {
        background: rgba(201, 144, 51, 0.14);
        color: #956009;
      }

      .farm-helper-status.bad {
        background: rgba(190, 82, 82, 0.12);
        color: #9c3434;
      }

      .farm-helper-footnote {
        color: #68805c;
        font-size: 12px;
      }

      @media (max-width: 900px) {
        .farm-helper-launcher {
          top: 12px;
          right: 12px;
          bottom: auto;
        }

        .farm-helper-window-bar,
        .farm-helper-window-actions,
        .farm-helper-hero {
          flex-direction: column;
          align-items: stretch;
        }

        .farm-helper-score {
          min-width: 0;
          text-align: left;
        }

        .farm-helper-metrics {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    `;
    document.head.appendChild(style);
  }

  function buildPanelHtml() {
    const mainBlock = [
      state.isLoading ? `<div class="farm-helper-state">正在抓接口并计算，请等一下。</div>` : "",
      state.error
        ? `<div class="farm-helper-error">数据加载失败：${escapeHtml(state.error)}</div>`
        : [
            state.warning ? `<div class="farm-helper-error">⚠ ${escapeHtml(state.warning)}</div>` : "",
            buildRecommendHtml(),
            buildRollingPlanHtml(),
            buildTableHtml(),
          ].join(""),
    ].join("");

    return `
      <button
        id="${APP_CONFIG.toggleButtonId}"
        class="farm-helper-launcher"
        type="button"
        aria-expanded="${uiState.open ? "true" : "false"}"
      >
        ${uiState.open ? "收起助手" : "打开助手"}
      </button>
      <div
        id="${APP_CONFIG.windowId}"
        class="farm-helper-window ${uiState.open ? "" : "is-hidden"}"
        style="${buildWindowStyle()}"
      >
        <div id="${APP_CONFIG.dragHandleId}" class="farm-helper-window-bar">
          <div class="farm-helper-window-title">
            <strong>种植助手</strong>
            <span>${escapeHtml(LONG_TERM_TITLE_TIP)}</span>
          </div>
          <div class="farm-helper-window-actions">
            <span class="farm-helper-time">${state.updatedAt ? `更新 ${escapeHtml(state.updatedAt)}` : "还没拿到数据"}</span>
            <button id="${APP_CONFIG.refreshButtonId}" class="farm-helper-button" type="button" ${state.isLoading ? "disabled" : ""}>
              ${state.isLoading ? "计算中..." : "刷新"}
            </button>
            <button id="${APP_CONFIG.closeButtonId}" class="farm-helper-button farm-helper-close-button" type="button">
              关闭
            </button>
          </div>
        </div>
        <div class="farm-helper-window-body">
          <div class="farm-helper-card">
            ${mainBlock}
            <div class="farm-helper-footnote">
              ${escapeHtml(LONG_TERM_FOOTNOTE)} 预计收菜时间 = 本次刷新时间 + 生长时间。菜场没货时种子价格按官方价算，菜场顺序不可信，脚本会自己排最低价。${escapeHtml(ROLLING_PLAN_FOOTNOTE)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  let rollingExpanded = false;

  // 展开时才算（模拟量不大，但没必要每次刷新都白算）
  function ensureRollingPlan() {
    if (state.rollingPlan || state.rows.length === 0) {
      return;
    }
    try {
      state.rollingPlan = buildRollingPlan(state.rows, state.maxSlots);
    } catch (error) {
      console.error("[farm-best-crop] rolling-plan", error);
      state.rollingPlan = { statusKey: "noPlots" };
    }
  }

  function buildRollingPlanHtml() {
    const head = `
      <div class="farm-helper-section-head">
        <h3>贵种子省钱的种法（用于农场大更新第一次种植的时候）</h3>
        <button
          id="${APP_CONFIG.rollingToggleButtonId}"
          class="farm-helper-button farm-helper-close-button"
          type="button"
        >${rollingExpanded ? "收起" : "展开看看"}</button>
      </div>
    `;

    if (!rollingExpanded) {
      return `
        <div class="farm-helper-section">
          ${head}
          <div class="farm-helper-tip">某个品种种子很贵但种出来很赚时，帮你算：先买几颗、剩下的用收的果子当种子慢慢铺满，比一次买齐能省多少。</div>
        </div>
      `;
    }

    ensureRollingPlan();
    const plan = state.rollingPlan;
    if (!plan) {
      return "";
    }

    if (plan.statusKey === "noPlots" || plan.statusKey === "noTarget") {
      return `
        <div class="farm-helper-section">
          ${head}
          <div class="farm-helper-empty">${escapeHtml(ROLLING_PLAN_STATUS_TEXT[plan.statusKey])}</div>
        </div>
      `;
    }

    const target = plan.target;
    if (plan.statusKey === "cannotSpread") {
      return `
        <div class="farm-helper-section">
          ${head}
          <div class="farm-helper-empty">「${escapeHtml(target.name)}」${escapeHtml(ROLLING_PLAN_STATUS_TEXT.cannotSpread)}，靠回本轮数慢慢回本就行。</div>
        </div>
      `;
    }

    if (plan.statusKey === "directBuy") {
      return `
        <div class="farm-helper-section">
          ${head}
          <div class="farm-helper-empty">${escapeHtml(plan.reasonText ?? ROLLING_PLAN_STATUS_TEXT.directBuy)}</div>
        </div>
      `;
    }

    // statusKey === "rolling"
    const fullXText = plan.fullXSeconds !== null
      ? `约 ${escapeHtml(formatDuration(plan.fullXSeconds))}（${escapeHtml(formatRounds(plan.fullXRounds))}）`
      : "" + formatRollingHorizonLabel() + "内没铺满，不划算";
    const stepLines = [
      `第 1 步：只买 ${plan.initialXPlots} 颗「${target.name}」种下，其余 ${plan.plotCount - plan.initialXPlots} 块地先种「${plan.transition.name}」卖钱。`,
      `第 2 步：「${target.name}」每轮结 ${target.harvestQuantity} 个果子，用果子当种子把「${plan.transition.name}」的地一块块换过来，不用再花买种子钱。`,
      `第 3 步：全部换成「${target.name}」后，每轮收的果子除了留种的全部卖掉。`,
    ].map((line, index) => `<div>${escapeHtml(line)}</div>`).join("");

    return `
      <div class="farm-helper-section">
        ${head}
        <div class="farm-helper-recommend">
          <div class="farm-helper-name">
            <strong style="font-size: 20px;">先买 ${escapeHtml(String(plan.initialXPlots))} 颗「${escapeHtml(target.name)}」，别一次买齐</strong>
          </div>
          <div class="farm-helper-tip">这东西种子一颗 ${escapeHtml(formatCoin(target.buyOneTotal))}。${escapeHtml(String(plan.plotCount))} 块地要是一开始就全买种子，得花 ${escapeHtml(formatCoin(plan.upfrontCostAllBuy))}；先买 ${escapeHtml(String(plan.initialXPlots))} 颗才 ${escapeHtml(formatCoin(plan.upfrontCostRolling))}。等它结果子，留几个果子当种子，就能把所有地都种上这个，后面一分种子钱都不用再花。${escapeHtml(plan.overtakeText)}${plan.scopeNote ? " " + escapeHtml(plan.scopeNote) : ""}</div>
          ${stepLines}
          <div class="farm-helper-metrics">
            ${buildMetricHtml("一次买齐要花", formatCoin(plan.upfrontCostAllBuy))}
            ${buildMetricHtml("先买 " + plan.initialXPlots + " 颗只要花", formatCoin(plan.upfrontCostRolling))}
            ${buildMetricHtml("全部换成它要", fullXText)}
            ${buildMetricHtml(formatRollingHorizonLabel() + "下来多赚", formatCoin(plan.finalDelta))}
          </div>
        </div>
      </div>
    `;
  }

  function buildRecommendHtml() {
    if (!state.recommendedRow) {
      return `
        <div class="farm-helper-section">
          <div class="farm-helper-section-head">
            <h3>当前推荐</h3>
            <span class="farm-helper-tip">按续种每小时利润</span>
          </div>
          <div class="farm-helper-empty">现在没有能直接推荐的作物。你可以先看下面全表。</div>
        </div>
      `;
    }

    const row = state.recommendedRow;
    const statusTone = getStatusTone(row.statusKey);
    return `
      <div class="farm-helper-section">
        <div class="farm-helper-section-head">
          <h3>当前推荐</h3>
          <span class="farm-helper-tip">按续种每小时利润</span>
        </div>
        <div class="farm-helper-recommend">
          <div class="farm-helper-hero">
            <div>
              <div class="farm-helper-name">
                <strong>${escapeHtml(row.name)}</strong>
                <span class="farm-helper-pill ${row.isVipOnly ? "vip" : ""}">
                  ${row.isVipOnly ? "VIP" : "普通"}
                </span>
                <span class="farm-helper-status ${statusTone}">${escapeHtml(row.statusText)}</span>
              </div>
              <div class="farm-helper-tip">按长期续种算（Lv1 基准，不含地块加成）：首购只花一次钱，回本后每轮都是纯赚。贵种子应优先种在你现有的最高级地上。</div>
              <div class="farm-helper-tip">
                生长 ${escapeHtml(formatDuration(row.growthSeconds))}，单块收 ${escapeHtml(String(row.harvestQuantity))} 个，预计 ${escapeHtml(formatDateTime(row.expectedHarvestAt))} 收。
              </div>
            </div>
            <div class="farm-helper-score">
              <span>${escapeHtml(LONG_TERM_SCORE_LABEL)}</span>
              <strong>${escapeHtml(getRecommendationMetricText(row))}</strong>
            </div>
          </div>
          <div class="farm-helper-metrics">
            ${buildMetricHtml("续种每小时利润", formatCoin(row.replantHourlyProfit))}
            ${buildMetricHtml("回本轮数", formatRounds(row.replantBreakEvenRounds))}
            ${buildMetricHtml("含税种子实际价", formatPurchase(row.buyOneResult))}
            ${buildMetricHtml("续种单轮利润", formatCoin(row.replantProfit))}
            ${buildMetricHtml("预计收菜时间", formatDateTime(row.expectedHarvestAt))}
            ${buildMetricHtml("交易所卖出单价", formatCoin(row.recyclePrice))}
            ${buildMetricHtml("菜场种子最低单价", formatCoin(row.marketMinUnitPrice))}
            ${buildMetricHtml("官方种子单价", formatCoin(row.officialSeedPrice))}
          </div>
        </div>
      </div>
    `;
  }

  function buildMetricHtml(label, value) {
    return `
      <div class="farm-helper-metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function buildPlotUnlockHtml() {
    return "";
  }

  function buildTableHtml() {
    if (state.rows.length === 0) {
      return `
        <div class="farm-helper-section">
          <div class="farm-helper-section-head">
            <h3>全部作物</h3>
          </div>
          <div class="farm-helper-empty">还没有可展示的数据。</div>
        </div>
      `;
    }

    const rowsHtml = state.rows
      .map((row, index) => {
        const buyOneTone = getPurchaseTone(row.buyOneResult, row.officialSeedPrice, 1);
        const officialDiffTone = getOfficialDiffTone(row.officialDiff);
        const replantHourlyTone = getProfitTone(row.replantHourlyProfit);
        return `
          <tr class="${isAvailableCropRow(row) ? "" : "is-dim"}">
            <td>${index + 1}</td>
            <td>
              <div class="farm-helper-name">
                <strong style="font-size:14px;">${escapeHtml(row.name)}</strong>
                <span class="farm-helper-pill ${row.isVipOnly ? "vip" : ""}">
                  ${row.isVipOnly ? "VIP" : "普通"}
                </span>
              </div>
            </td>
            <td>${escapeHtml(formatDuration(row.growthSeconds))} → ${escapeHtml(formatDuration(row.bestGrowthSeconds))}</td>
            <td>${escapeHtml(String(row.harvestQuantity))} → ${escapeHtml(String(row.bestQuantity))}</td>
            <td>${escapeHtml(formatCoin(row.replantHourlyProfit))}</td>
            <td>${escapeHtml(formatCoin(row.replantProfit))}</td>
            <td>${escapeHtml(formatCoin(row.roundProfit))}</td>
            <td>${escapeHtml(formatCoin(row.hourlyProfit))}</td>
            <td>${escapeHtml(formatCoin(row.recyclePrice))}</td>
            <td>${escapeHtml(formatCoin(row.marketMinUnitPrice))}</td>
            <td>${escapeHtml(formatCoin(row.officialSeedPrice))}</td>
            <td>${buildTableValue(formatCoin(row.officialDiff), officialDiffTone)}</td>
            <td>${buildTableValue(formatPurchase(row.buyOneResult), buyOneTone)}</td>
            <td>${escapeHtml(formatDateTime(row.expectedHarvestAt))}</td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="farm-helper-section">
        <div class="farm-helper-section-head">
          <h3>全部作物</h3>
          <span class="farm-helper-tip">${escapeHtml(LONG_TERM_TABLE_TIP)}</span>
        </div>
        <div class="farm-helper-table-wrap">
          <table class="farm-helper-table">
            <thead>
              <tr>
                <th>序</th>
                <th>作物</th>
                <th>生长（→最高级地）</th>
                <th>单块收获（→最高级地）</th>
                <th>续种每小时利润（Lv1）</th>
                <th>续种单轮利润（Lv1）</th>
                <th>首轮利润</th>
                <th>首轮每小时利润</th>
                <th>交易所卖出单价</th>
                <th>菜场种子最低单价</th>
                <th>官方种子单价</th>
                <th>种子价差</th>
                <th>含税种子实际价</th>
                <th>预计收菜时间</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function getStatusTone(statusKey) {
    if (statusKey === "ok") {
      return "ok";
    }
    if (statusKey === "quoteFailed" || statusKey === "marketError") {
      return "bad";
    }
    return "warn";
  }

  function buildTableValue(value, tone) {
    const className = ["farm-helper-table-value", tone.className].filter(Boolean).join(" ");
    const titleAttribute = tone.title ? ` title="${escapeHtml(tone.title)}"` : "";
    return `<span class="${className}"${titleAttribute}>${escapeHtml(value)}</span>`;
  }

  function getPurchaseTone(result, officialSeedPrice, quantity) {
    if (result?.status !== "ok" || !Number.isFinite(officialSeedPrice)) {
      return {
        className: "",
        title: "",
      };
    }

    const officialTotal = officialSeedPrice * quantity;
    const delta = result.buyerPaysTotal - officialTotal;

    if (delta > 0) {
      return {
        className: "bad",
        title: `比官方贵 ${formatCoin(delta)}`,
      };
    }
    if (delta < 0) {
      return {
        className: "good",
        title: `比官方便宜 ${formatCoin(Math.abs(delta))}`,
      };
    }

    return {
      className: "",
      title: "和官方一样",
    };
  }

  function getOfficialDiffTone(officialDiff) {
    if (!Number.isFinite(officialDiff)) {
      return {
        className: "",
        title: "",
      };
    }

    if (officialDiff > 0) {
      return {
        className: "good",
        title: `比官方便宜 ${formatCoin(officialDiff)}`,
      };
    }
    if (officialDiff < 0) {
      return {
        className: "bad",
        title: `比官方贵 ${formatCoin(Math.abs(officialDiff))}`,
      };
    }

    return {
      className: "",
      title: "和官方一样",
    };
  }

  function formatPurchase(result) {
    if (!result) {
      return "--";
    }
    if (result.status === "ok" || result.status === "officialPrice") {
      return formatCoin(result.buyerPaysTotal);
    }
    if (result.status === "insufficient") {
      return `数量不够(${result.availableQuantity})`;
    }
    if (result.status === "quoteFailed") {
      return "报价失败";
    }
    return "--";
  }

  function formatCoin(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }

    const displayValue = value / APP_CONFIG.coinScale;
    const absoluteValue = Math.abs(displayValue);
    let maximumFractionDigits = 6;

    if (absoluteValue >= 100) {
      maximumFractionDigits = 2;
    } else if (absoluteValue >= 1) {
      maximumFractionDigits = 4;
    }

    return `${displayValue.toLocaleString("zh-CN", {
      minimumFractionDigits: 0,
      maximumFractionDigits,
    })}刀`;
  }

  function getProfitTone(value) {
    if (!Number.isFinite(value)) {
      return {
        className: "",
        title: "",
      };
    }
    if (value > 0) {
      return {
        className: "good",
        title: "",
      };
    }
    if (value < 0) {
      return {
        className: "bad",
        title: "",
      };
    }
    return {
      className: "",
      title: "",
    };
  }

  function formatRounds(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${value}轮`;
  }

  function formatBreakEvenDuration(seconds) {
    if (!Number.isFinite(seconds)) {
      return "回不了本";
    }

    const totalMinutes = Math.ceil(seconds / 60);
    const days = Math.floor(totalMinutes / 1440);
    const remainingMinutes = totalMinutes % 1440;
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;

    if (days > 0) {
      return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
    }
    if (hours > 0) {
      return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
    }
    if (minutes > 0) {
      return `${minutes}分`;
    }
    return `${seconds}秒`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) {
      return "--";
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0 && minutes > 0) {
      return `${hours}小时${minutes}分`;
    }
    if (hours > 0) {
      return `${hours}小时`;
    }
    if (minutes > 0) {
      return `${minutes}分`;
    }
    return `${seconds}秒`;
  }

  function formatDateTime(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return "--";
    }

    return `${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function padNumber(value) {
    return String(value).padStart(2, "0");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function toNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }

  function toNullableNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  function toFiniteNumber(value, fallbackValue) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallbackValue;
  }

  function formatLevel(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${value}级`;
  }

  function clamp(value, minValue, maxValue) {
    return Math.min(Math.max(value, minValue), maxValue);
  }

  function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return "未知错误";
  }
})();
