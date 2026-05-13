// ==UserScript==
// @name         农场最佳种植助手
// @namespace    hybgzs-farm-helper
// @version      0.1.2
// @description  算现在种什么更值
// @match        https://cdk.hybgzs.com/entertainment/farm*
// @match        https://cdk.hybgzs.com/entertainment/farm/*
// @run-at       document-idle
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
    toggleButtonId: "farm-best-crop-toggle",
    closeButtonId: "farm-best-crop-close",
    windowId: "farm-best-crop-window",
    dragHandleId: "farm-best-crop-drag-handle",
    storageKey: "farm-best-crop-window-state",
    marketFetchConcurrency: 4,
    windowMargin: 16,
    defaultWindowWidth: 960,
    defaultWindowHeight: 720,
    minWindowWidth: 360,
    minWindowHeight: 320,
  });

  const STATUS_TEXT = Object.freeze({
    ok: "可买",
    marketEmpty: "菜场没货",
    marketEmptyOfficial: "菜场没货，按官方价算",
    marketError: "菜场失败",
    insufficientMarket: "数量不够",
    quoteFailed: "报价失败",
    noRecyclePrice: "无交易所价",
  });

  const REPLANT_KEEP_QUANTITY = 1;
  const AVAILABLE_STATUS_KEYS = Object.freeze(["ok", "marketEmptyOfficial"]);
  const PLOT_UNLOCK_STATUS_TEXT = Object.freeze({
    ready: "现在可开",
    noNextUnlock: "地块已全部开完",
    unavailable: "还没拿到开地数据",
    levelLocked: "等级不够",
  });

  const PROFIT_TAB = Object.freeze({
    currentRound: "currentRound",
    longTerm: "longTerm",
  });

  const PROFIT_TAB_OPTIONS = Object.freeze(
    [
      {
        id: PROFIT_TAB.currentRound,
        label: "当前一轮",
        description: "按现在买 1 个再种 1 轮后的单轮利润比较。",
        scoreLabel: "单轮利润",
        titleTip: "先看推荐，再看全表。现在按单轮利润排。",
        tableTip: "表里有全部信息，现在按单轮利润从高到低排。",
        footnote:
          "单轮利润 = 单块收获总卖价 - 买1个实际总价。当前一轮会按单轮利润从高到低排序，利润相同优先买价更低的。",
      },
      {
        id: PROFIT_TAB.longTerm,
        label: "长期续种",
        description: "假设每轮收获后留 1 个继续种，比较以后每轮还能卖出的利润。",
        scoreLabel: "续种利润",
        titleTip: "先看推荐，再看全表。现在按续种利润排。",
        tableTip: "表里有全部信息，现在按续种利润从高到低排。",
        footnote:
          "续种利润 = 留 1 个继续种之后，这一轮剩下收成按交易所价格卖出的利润。长期续种会按续种利润从高到低排序，数值相同优先看首轮利润。",
      },
    ].map((option) => Object.freeze(option)),
  );

  const DEFAULT_PROFIT_TAB = PROFIT_TAB.currentRound;

  const state = {
    isLoading: false,
    error: "",
    rows: [],
    plotSummary: null,
    recommendedRow: null,
    updatedAt: "",
  };

  const uiState = loadUiState();
  const quoteCache = new Map();
  let booted = false;
  let loadToken = 0;
  let resizeObserver = null;
  let dragState = null;

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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }

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
      state.updatedAt = formatTime(snapshot.updatedAt);
      state.error = "";
    } catch (error) {
      if (currentToken !== loadToken) {
        return;
      }
      console.error("[farm-best-crop]", error);
      state.rows = [];
      state.plotSummary = null;
      state.recommendedRow = null;
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
    const [seeds, recyclePriceMap, plotsInfo] = await Promise.all([
      fetchSeeds(),
      fetchRecyclePriceMap(),
      fetchPlotsInfo().catch((error) => {
        console.warn("[farm-best-crop] plots", error);
        return null;
      }),
    ]);

    const marketMap = await fetchMarketMap(seeds);
    const rawRows = await mapWithConcurrency(seeds, APP_CONFIG.marketFetchConcurrency, async (seed) =>
      buildCropRow(seed, recyclePriceMap.get(seed.id) ?? null, marketMap.get(seed.id), plotsInfo?.nextUnlock ?? null),
    );
    const updatedAt = Date.now();
    const rows = rawRows.map((row) => ({
      ...row,
      expectedHarvestAt: buildExpectedHarvestAt(updatedAt, row.growthSeconds),
    }));
    const sortedRows = sortRows(rows, uiState.profitTab);
    const plotSummary = buildPlotSummary(rows, plotsInfo);
    const recommendedRow = getRecommendedRow(sortedRows, uiState.profitTab);

    return {
      rows: sortedRows,
      plotSummary,
      recommendedRow,
      updatedAt: new Date(updatedAt),
    };
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

  function normalizePlotsInfo(data) {
    if (!data || typeof data !== "object") {
      return null;
    }

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

  async function buildCropRow(seed, recyclePrice, marketSnapshot, nextUnlock) {
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
    const hourlyProfit =
      roundProfit !== null && seed.growthSeconds > 0
        ? roundProfit / (seed.growthSeconds / 3600)
        : null;
    const costPerformance =
      Number.isFinite(buyOneTotal) && hourlyProfit !== null && buyOneTotal > 0
        ? hourlyProfit / buyOneTotal
        : null;
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
      hourlyProfit,
      costPerformance,
      officialDiff,
      statusKey: status.key,
      statusText: status.text,
    };
    const plotBreakEven = buildPlotBreakEven(row, nextUnlock);

    return {
      ...row,
      ...plotBreakEven,
    };
  }

  function buildPlotBreakEven(row, nextUnlock) {
    const unlockCost = nextUnlock?.cost;
    if (!Number.isFinite(unlockCost) || !isAvailableCropRow(row)) {
      return {
        plotBreakEvenRounds: null,
        plotBreakEvenSeconds: null,
      };
    }
    if (!Number.isFinite(row.roundProfit) || !Number.isFinite(row.replantProfit) || row.growthSeconds <= 0) {
      return {
        plotBreakEvenRounds: null,
        plotBreakEvenSeconds: null,
      };
    }
    if (row.roundProfit >= unlockCost) {
      return {
        plotBreakEvenRounds: 1,
        plotBreakEvenSeconds: row.growthSeconds,
      };
    }
    if (row.replantProfit <= 0) {
      return {
        plotBreakEvenRounds: Infinity,
        plotBreakEvenSeconds: Infinity,
      };
    }

    const extraRounds = Math.ceil((unlockCost - row.roundProfit) / row.replantProfit);
    const totalRounds = 1 + Math.max(extraRounds, 0);
    return {
      plotBreakEvenRounds: totalRounds,
      plotBreakEvenSeconds: totalRounds * row.growthSeconds,
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

  function sortRows(rows, profitTab = uiState.profitTab) {
    return sortRowsByProfitTab(rows, profitTab);
  }

  function sortRowsByProfitTab(rows, profitTab = uiState.profitTab) {
    const normalizedProfitTab = normalizeProfitTab(profitTab);
    return [...rows].sort((left, right) => compareRowsByProfitTab(left, right, normalizedProfitTab));
  }

  function compareRowsByProfitTab(left, right, profitTab) {
    if (profitTab === PROFIT_TAB.longTerm) {
      const replantProfitDiff = compareFiniteDesc(left.replantProfit, right.replantProfit);
      if (replantProfitDiff !== 0) {
        return replantProfitDiff;
      }

      const roundProfitDiff = compareFiniteDesc(left.roundProfit, right.roundProfit);
      if (roundProfitDiff !== 0) {
        return roundProfitDiff;
      }

      const costDiff = compareFiniteAsc(left.buyOneTotal, right.buyOneTotal);
      if (costDiff !== 0) {
        return costDiff;
      }

      return left.name.localeCompare(right.name, "zh-CN");
    }

    const roundProfitDiff = compareFiniteDesc(left.roundProfit, right.roundProfit);
    if (roundProfitDiff !== 0) {
      return roundProfitDiff;
    }

    const costDiff = compareFiniteAsc(left.buyOneTotal, right.buyOneTotal);
    if (costDiff !== 0) {
      return costDiff;
    }

    return left.name.localeCompare(right.name, "zh-CN");
  }

  function getRecommendedRow(rows, profitTab = uiState.profitTab) {
    return rows.find((row) => isRecommendedCandidate(row, profitTab)) ?? null;
  }

  function isRecommendedCandidate(row, profitTab = uiState.profitTab) {
    return isAvailableCropRow(row) && Number.isFinite(getProfitMetricValue(row, profitTab));
  }

  function getProfitMetricValue(row, profitTab = uiState.profitTab) {
    if (normalizeProfitTab(profitTab) === PROFIT_TAB.longTerm) {
      return row.replantProfit;
    }
    return row.roundProfit;
  }

  function getRecommendationMetricText(row, profitTab = uiState.profitTab) {
    return formatCoin(getProfitMetricValue(row, profitTab));
  }

  function getProfitTabConfig(profitTab = uiState.profitTab) {
    const normalizedProfitTab = normalizeProfitTab(profitTab);
    return PROFIT_TAB_OPTIONS.find((option) => option.id === normalizedProfitTab) ?? PROFIT_TAB_OPTIONS[0];
  }

  function normalizeProfitTab(profitTab) {
    return PROFIT_TAB_OPTIONS.some((option) => option.id === profitTab) ? profitTab : DEFAULT_PROFIT_TAB;
  }

  function isAvailableCropRow(row) {
    return AVAILABLE_STATUS_KEYS.includes(row.statusKey);
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

  function applyCurrentProfitTab() {
    state.rows = sortRowsByProfitTab(state.rows, uiState.profitTab);
    state.recommendedRow = getRecommendedRow(state.rows, uiState.profitTab);
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
      profitTab: DEFAULT_PROFIT_TAB,
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
      profitTab: normalizeProfitTab(nextState.profitTab),
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

    const closeButton = panel.querySelector(`#${APP_CONFIG.closeButtonId}`);
    if (closeButton) {
      closeButton.addEventListener("click", () => {
        setUiState({ open: false }, true);
        render();
      });
    }

    panel.querySelectorAll("[data-profit-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextProfitTab = normalizeProfitTab(button.getAttribute("data-profit-tab"));
        if (nextProfitTab === uiState.profitTab) {
          return;
        }
        setUiState({ profitTab: nextProfitTab }, true);
        applyCurrentProfitTab();
        maybeLoadDataForOpenWindow();
        render();
      });
    });

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
    const profitTabConfig = getProfitTabConfig();
    const mainBlock = [
      buildProfitTabHtml(profitTabConfig),
      buildPlotUnlockHtml(),
      state.isLoading ? `<div class="farm-helper-state">正在抓接口并计算，请等一下。</div>` : "",
      state.error
        ? `<div class="farm-helper-error">数据加载失败：${escapeHtml(state.error)}</div>`
        : [buildRecommendHtml(profitTabConfig), buildTableHtml(profitTabConfig)].join(""),
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
            <span>${escapeHtml(profitTabConfig.titleTip)}</span>
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
              ${escapeHtml(profitTabConfig.footnote)} 预计收菜时间 = 本次刷新时间 + 生长时间。开地回本 = 首轮利润 + 后续每轮续种利润累计覆盖开地成本。菜场没货时按官方价算，菜场顺序不可信，脚本会自己排最低价。
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function buildProfitTabHtml(currentTabConfig = getProfitTabConfig()) {
    const buttonsHtml = PROFIT_TAB_OPTIONS.map((option) => {
      const isActive = option.id === currentTabConfig.id;
      return `
        <button
          class="farm-helper-tab-button ${isActive ? "is-active" : ""}"
          type="button"
          data-profit-tab="${escapeHtml(option.id)}"
          aria-pressed="${isActive ? "true" : "false"}"
        >
          ${escapeHtml(option.label)}
        </button>
      `;
    }).join("");

    return `
      <div class="farm-helper-section">
        <div class="farm-helper-tab-panel">
          <div class="farm-helper-section-head">
            <h3>看哪种利润</h3>
            <span class="farm-helper-tip">会记住你上次看的页签</span>
          </div>
          <div class="farm-helper-tab-buttons">${buttonsHtml}</div>
          <div class="farm-helper-tab-desc">
            当前看 <strong>${escapeHtml(currentTabConfig.label)}</strong>：${escapeHtml(currentTabConfig.description)}
          </div>
        </div>
      </div>
    `;
  }

  function buildRecommendHtml(currentRule = getProfitTabConfig()) {
    if (!state.recommendedRow) {
      return `
        <div class="farm-helper-section">
          <div class="farm-helper-section-head">
            <h3>当前推荐</h3>
            <span class="farm-helper-tip">当前规则：${escapeHtml(currentRule.label)}</span>
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
          <span class="farm-helper-tip">当前规则：${escapeHtml(currentRule.label)}</span>
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
              <div class="farm-helper-tip">当前规则：${escapeHtml(currentRule.description)}</div>
              <div class="farm-helper-tip">
                生长 ${escapeHtml(formatDuration(row.growthSeconds))}，单块收 ${escapeHtml(String(row.harvestQuantity))} 个，预计 ${escapeHtml(formatDateTime(row.expectedHarvestAt))} 收。
              </div>
            </div>
            <div class="farm-helper-score">
              <span>${escapeHtml(currentRule.scoreLabel)}</span>
              <strong>${escapeHtml(getRecommendationMetricText(row, currentRule.id))}</strong>
            </div>
          </div>
          <div class="farm-helper-metrics">
            ${buildMetricHtml("性价比", formatRatio(row.costPerformance))}
            ${buildMetricHtml("每小时利润", formatCoin(row.hourlyProfit))}
            ${buildMetricHtml("买1个实际总价", formatPurchase(row.buyOneResult))}
            ${buildMetricHtml("单轮利润", formatCoin(row.roundProfit))}
            ${buildMetricHtml("续种利润", formatCoin(row.replantProfit))}
            ${buildMetricHtml("开地回本时间", formatBreakEvenDuration(row.plotBreakEvenSeconds))}
            ${buildMetricHtml("开地回本轮数", formatBreakEvenRounds(row.plotBreakEvenRounds))}
            ${buildMetricHtml("预计收菜时间", formatDateTime(row.expectedHarvestAt))}
            ${buildMetricHtml("交易所单价", formatCoin(row.recyclePrice))}
            ${buildMetricHtml("菜场最低单价", formatCoin(row.marketMinUnitPrice))}
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
    const summary = state.plotSummary;
    if (!summary) {
      return "";
    }

    if (!summary.nextUnlock) {
      return `
        <div class="farm-helper-section">
          <div class="farm-helper-section-head">
            <h3>下一块地</h3>
            <span class="farm-helper-tip">${escapeHtml(summary.statusText)}</span>
          </div>
        </div>
      `;
    }

    const bestRow = summary.bestRow;
    const plotIndexText = Number.isFinite(summary.nextUnlock.plotIndex) ? `第 ${summary.nextUnlock.plotIndex} 块` : "下一块";
    const plotTypeText = summary.nextUnlockIsVip ? "VIP地块" : "普通地块";
    const bestCropText = bestRow ? bestRow.name : "暂时算不出";
    const bestTimeText = bestRow ? formatBreakEvenDuration(bestRow.plotBreakEvenSeconds) : "--";
    const bestRoundsText = bestRow ? formatBreakEvenRounds(bestRow.plotBreakEvenRounds) : "--";

    return `
      <div class="farm-helper-section">
        <div class="farm-helper-section-head">
          <h3>下一块地</h3>
          <span class="farm-helper-tip">${escapeHtml(summary.statusText)}</span>
        </div>
        <div class="farm-helper-recommend plot-unlock">
          <div class="farm-helper-hero">
            <div>
              <div class="farm-helper-name">
                <strong>${escapeHtml(plotIndexText)}</strong>
                <span class="farm-helper-pill ${summary.nextUnlockIsVip ? "vip" : ""}">${escapeHtml(plotTypeText)}</span>
              </div>
              <div class="farm-helper-tip">
                开地成本 ${escapeHtml(formatCoin(summary.nextUnlock.cost))}，${escapeHtml(summary.statusText)}。
              </div>
              <div class="farm-helper-tip">开地回本按首轮利润 + 后续续种利润累计计算。</div>
            </div>
            <div class="farm-helper-score">
              <span>最快回本</span>
              <strong>${escapeHtml(bestTimeText)}</strong>
            </div>
          </div>
          <div class="farm-helper-metrics">
            ${buildMetricHtml("开地成本", formatCoin(summary.nextUnlock.cost))}
            ${buildMetricHtml("地块类型", plotTypeText)}
            ${buildMetricHtml("所需等级", formatLevel(summary.nextUnlock.requiredLevel))}
            ${buildMetricHtml("最快回本作物", bestCropText)}
            ${buildMetricHtml("最快回本轮数", bestRoundsText)}
            ${buildMetricHtml("最快回本时间", bestTimeText)}
          </div>
        </div>
      </div>
    `;
  }

  function buildTableHtml(currentRule = getProfitTabConfig()) {
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
        const statusTone = getStatusTone(row.statusKey);
        const buyOneTone = getPurchaseTone(row.buyOneResult, row.officialSeedPrice, 1);
        const officialDiffTone = getOfficialDiffTone(row.officialDiff);
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
            <td>${escapeHtml(formatDuration(row.growthSeconds))}</td>
            <td>${escapeHtml(String(row.harvestQuantity))}</td>
            <td>${escapeHtml(formatCoin(row.recyclePrice))}</td>
            <td>${escapeHtml(formatCoin(row.marketMinUnitPrice))}</td>
            <td>${buildTableValue(formatPurchase(row.buyOneResult), buyOneTone)}</td>
            <td>${escapeHtml(formatCoin(row.roundProfit))}</td>
            <td>${escapeHtml(formatCoin(row.replantProfit))}</td>
            <td>${escapeHtml(formatBreakEvenRounds(row.plotBreakEvenRounds))}</td>
            <td>${escapeHtml(formatBreakEvenDuration(row.plotBreakEvenSeconds))}</td>
            <td>${escapeHtml(formatCoin(row.hourlyProfit))}</td>
            <td>${escapeHtml(formatDateTime(row.expectedHarvestAt))}</td>
            <td>${escapeHtml(formatRatio(row.costPerformance))}</td>
            <td>${escapeHtml(formatCoin(row.officialSeedPrice))}</td>
            <td>${buildTableValue(formatCoin(row.officialDiff), officialDiffTone)}</td>
            <td><span class="farm-helper-status ${statusTone}">${escapeHtml(row.statusText)}</span></td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="farm-helper-section">
        <div class="farm-helper-section-head">
          <h3>全部作物</h3>
          <span class="farm-helper-tip">${escapeHtml(currentRule.tableTip)}</span>
        </div>
        <div class="farm-helper-table-wrap">
          <table class="farm-helper-table">
            <thead>
              <tr>
                <th>序</th>
                <th>作物</th>
                <th>生长</th>
                <th>单块收获</th>
                <th>交易所单价</th>
                <th>菜场最低单价</th>
                <th>买1个实际总价</th>
                <th>单轮利润</th>
                <th>续种利润</th>
                <th>开地回本轮数</th>
                <th>开地回本时间</th>
                <th>每小时利润</th>
                <th>预计收菜时间</th>
                <th>性价比</th>
                <th>官方种子单价</th>
                <th>官方价差</th>
                <th>状态</th>
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

  function formatRatio(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    const absoluteValue = Math.abs(value);
    const digits = absoluteValue >= 1 ? 4 : 6;
    return value.toLocaleString("zh-CN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    });
  }

  function formatBreakEvenRounds(value) {
    if (value === Infinity) {
      return "回不了本";
    }
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${value}轮`;
  }

  function formatBreakEvenDuration(seconds) {
    if (seconds === Infinity) {
      return "回不了本";
    }
    if (!Number.isFinite(seconds)) {
      return "--";
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
