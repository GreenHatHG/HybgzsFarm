// ==UserScript==
// @name         农场最佳种植助手
// @namespace    hybgzs-farm-helper
// @version      0.1.0
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
    userInfoUrl: "https://cdk.hybgzs.com/api/user/info",
    marketPageLimit: 20,
    recyclePageSize: 8,
    coinScale: 500_000,
    balanceCandidateLimit: 8,
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

  const SORT_MODE = Object.freeze({
    costPerformance: "costPerformance",
    timePriority: "timePriority",
    singleProfit: "singleProfit",
  });

  const SORT_MODE_OPTIONS = Object.freeze(
    [
      {
        id: SORT_MODE.costPerformance,
        label: "性价比",
        description: "适合钱少，想看这笔钱值不值",
        scoreLabel: "性价比",
      },
      {
        id: SORT_MODE.timePriority,
        label: "时间优先",
        description: "适合常回来收，想让地每小时赚更多",
        scoreLabel: "每小时利润",
      },
      {
        id: SORT_MODE.singleProfit,
        label: "单次利润",
        description: "适合不常看，想每次收的时候赚更多",
        scoreLabel: "单轮利润",
      },
    ].map((option) => Object.freeze(option)),
  );

  const DEFAULT_SORT_MODE = SORT_MODE.costPerformance;

  const BALANCE_RECOMMENDATION_STATUS = Object.freeze({
    loading: "loading",
    ready: "ready",
    walletUnavailable: "walletUnavailable",
    slotsUnavailable: "slotsUnavailable",
    noCandidates: "noCandidates",
    noAffordable: "noAffordable",
  });

  const state = {
    isLoading: false,
    error: "",
    rows: [],
    recommendedRow: null,
    updatedAt: "",
    walletBalance: null,
    maxSlots: null,
    balanceRecommendation: null,
    marketMap: null,
  };

  const uiState = loadUiState();
  const quoteCache = new Map();
  let booted = false;
  let loadToken = 0;
  let balanceToken = 0;
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
    void loadData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }

  async function loadData() {
    const currentToken = ++loadToken;
    balanceToken += 1;
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
      state.recommendedRow = snapshot.recommendedRow;
      state.updatedAt = formatTime(snapshot.updatedAt);
      state.walletBalance = snapshot.walletBalance;
      state.maxSlots = snapshot.maxSlots;
      state.balanceRecommendation = snapshot.balanceRecommendation;
      state.marketMap = snapshot.marketMap;
      state.error = "";
    } catch (error) {
      if (currentToken !== loadToken) {
        return;
      }
      console.error("[farm-best-crop]", error);
      state.rows = [];
      state.recommendedRow = null;
      state.updatedAt = "";
      state.walletBalance = null;
      state.maxSlots = null;
      state.balanceRecommendation = null;
      state.marketMap = null;
      state.error = toErrorMessage(error);
    } finally {
      if (currentToken !== loadToken) {
        return;
      }
      state.isLoading = false;
      render();
    }
  }

  async function collectSnapshot() {
    const [seeds, recyclePriceMap, walletResult, slotsResult] = await Promise.all([
      fetchSeeds(),
      fetchRecyclePriceMap(),
      fetchOptionalValue(fetchWalletBalance, "user-info"),
      fetchOptionalValue(fetchFarmMaxSlots, "farm-crops"),
    ]);

    const marketMap = await fetchMarketMap(seeds);
    const rawRows = await mapWithConcurrency(seeds, APP_CONFIG.marketFetchConcurrency, async (seed) =>
      buildCropRow(seed, recyclePriceMap.get(seed.id) ?? null, marketMap.get(seed.id)),
    );
    const updatedAt = Date.now();
    const rows = rawRows.map((row) => ({
      ...row,
      expectedHarvestAt: buildExpectedHarvestAt(updatedAt, row.growthSeconds),
    }));
    const sortedRows = sortRows(rows, uiState.sortMode);
    const recommendedRow = getRecommendedRow(sortedRows, uiState.sortMode);
    const balanceRecommendation = await buildBalanceRecommendation({
      rows: sortedRows,
      marketMap,
      walletBalance: walletResult.value,
      maxSlots: slotsResult.value,
      sortMode: uiState.sortMode,
      walletError: walletResult.error,
      slotsError: slotsResult.error,
    });

    return {
      rows: sortedRows,
      recommendedRow,
      walletBalance: walletResult.value,
      maxSlots: slotsResult.value,
      balanceRecommendation,
      marketMap,
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

  async function fetchWalletBalance() {
    const response = await requestJson(APP_CONFIG.userInfoUrl);
    const walletBalance = toNullableNumber(response.data?.walletBalance);
    if (!Number.isFinite(walletBalance)) {
      throw new Error("余额字段缺失");
    }
    return walletBalance;
  }

  async function fetchFarmMaxSlots() {
    const response = await requestJson("/crops");
    const maxSlots = toNullableNumber(response.maxSlots);
    if (!Number.isFinite(maxSlots)) {
      throw new Error("地块数字段缺失");
    }
    return Math.max(0, Math.floor(maxSlots));
  }

  async function fetchOptionalValue(loader, label) {
    try {
      return {
        value: await loader(),
        error: "",
      };
    } catch (error) {
      console.warn(`[farm-best-crop] ${label}`, error);
      return {
        value: null,
        error: toErrorMessage(error),
      };
    }
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

  async function buildCropRow(seed, recyclePrice, marketSnapshot) {
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

    return {
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
      hourlyProfit,
      costPerformance,
      officialDiff,
      statusKey: status.key,
      statusText: status.text,
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

  function sortRows(rows, sortMode = uiState.sortMode) {
    return sortRowsByMode(rows, sortMode);
  }

  function sortRowsByMode(rows, sortMode) {
    const normalizedSortMode = normalizeSortMode(sortMode);
    return [...rows].sort((left, right) => {
      const sortDiff = compareRowsBySortMode(left, right, normalizedSortMode);
      if (sortDiff !== 0) {
        return sortDiff;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
  }

  function compareRowsBySortMode(left, right, sortMode) {
    if (sortMode === SORT_MODE.timePriority) {
      const hourlyDiff = compareFiniteDesc(left.hourlyProfit, right.hourlyProfit);
      if (hourlyDiff !== 0) {
        return hourlyDiff;
      }

      const harvestDiff = compareFiniteAsc(left.expectedHarvestAt, right.expectedHarvestAt);
      if (harvestDiff !== 0) {
        return harvestDiff;
      }

      return compareFiniteAsc(left.buyOneTotal, right.buyOneTotal);
    }

    if (sortMode === SORT_MODE.singleProfit) {
      const roundProfitDiff = compareFiniteDesc(left.roundProfit, right.roundProfit);
      if (roundProfitDiff !== 0) {
        return roundProfitDiff;
      }

      const hourlyDiff = compareFiniteDesc(left.hourlyProfit, right.hourlyProfit);
      if (hourlyDiff !== 0) {
        return hourlyDiff;
      }

      return compareFiniteAsc(left.buyOneTotal, right.buyOneTotal);
    }

    const costDiff = compareFiniteDesc(left.costPerformance, right.costPerformance);
    if (costDiff !== 0) {
      return costDiff;
    }

    const hourlyDiff = compareFiniteDesc(left.hourlyProfit, right.hourlyProfit);
    if (hourlyDiff !== 0) {
      return hourlyDiff;
    }

    return compareFiniteAsc(left.buyOneTotal, right.buyOneTotal);
  }

  function getRecommendedRow(rows, sortMode) {
    return rows.find((row) => isRecommendedCandidate(row, sortMode)) ?? null;
  }

  function isRecommendedCandidate(row, sortMode = uiState.sortMode) {
    const isAvailable = row.statusKey === "ok" || row.statusKey === "marketEmptyOfficial";
    return isAvailable && Number.isFinite(getSortMetricValue(row, sortMode));
  }

  function getSortMetricValue(row, sortMode = uiState.sortMode) {
    const normalizedSortMode = normalizeSortMode(sortMode);
    if (normalizedSortMode === SORT_MODE.timePriority) {
      return row.hourlyProfit;
    }
    if (normalizedSortMode === SORT_MODE.singleProfit) {
      return row.roundProfit;
    }
    return row.costPerformance;
  }

  function getSortMetricText(row, sortMode = uiState.sortMode) {
    const value = getSortMetricValue(row, sortMode);
    if (normalizeSortMode(sortMode) === SORT_MODE.costPerformance) {
      return formatRatio(value);
    }
    return formatCoin(value);
  }

  function getSortModeConfig(sortMode = uiState.sortMode) {
    const normalizedSortMode = normalizeSortMode(sortMode);
    return SORT_MODE_OPTIONS.find((option) => option.id === normalizedSortMode) ?? SORT_MODE_OPTIONS[0];
  }

  function normalizeSortMode(sortMode) {
    return SORT_MODE_OPTIONS.some((option) => option.id === sortMode) ? sortMode : DEFAULT_SORT_MODE;
  }

  function buildExpectedHarvestAt(updatedAt, growthSeconds) {
    if (!Number.isFinite(updatedAt) || !Number.isFinite(growthSeconds)) {
      return null;
    }
    return updatedAt + growthSeconds * 1000;
  }

  function applyCurrentSortMode() {
    state.rows = sortRowsByMode(state.rows, uiState.sortMode);
    state.recommendedRow = getRecommendedRow(state.rows, uiState.sortMode);
  }

  async function refreshBalanceRecommendation() {
    const currentToken = ++balanceToken;
    state.balanceRecommendation = createBalanceRecommendationMessage(
      BALANCE_RECOMMENDATION_STATUS.loading,
      "正在按余额算怎么买更合适。",
      {
        walletBalance: state.walletBalance,
        maxSlots: state.maxSlots,
      },
    );
    render();

    const balanceRecommendation = await buildBalanceRecommendation({
      rows: state.rows,
      marketMap: state.marketMap,
      walletBalance: state.walletBalance,
      maxSlots: state.maxSlots,
      sortMode: uiState.sortMode,
    });

    if (currentToken !== balanceToken) {
      return;
    }

    state.balanceRecommendation = balanceRecommendation;
    render();
  }

  async function buildBalanceRecommendation(context) {
    if (!Number.isFinite(context.walletBalance)) {
      return createBalanceRecommendationMessage(
        BALANCE_RECOMMENDATION_STATUS.walletUnavailable,
        context.walletError || "余额拿不到",
        {
          maxSlots: context.maxSlots,
        },
      );
    }

    if (!Number.isFinite(context.maxSlots)) {
      return createBalanceRecommendationMessage(
        BALANCE_RECOMMENDATION_STATUS.slotsUnavailable,
        context.slotsError || "地块数拿不到",
        {
          walletBalance: context.walletBalance,
        },
      );
    }

    const maxSlots = Math.max(0, Math.floor(context.maxSlots));
    const candidateRows = context.rows
      .filter((row) => isRecommendedCandidate(row, context.sortMode))
      .slice(0, APP_CONFIG.balanceCandidateLimit);

    if (candidateRows.length === 0) {
      return createBalanceRecommendationMessage(
        BALANCE_RECOMMENDATION_STATUS.noCandidates,
        "现在没有可参与余额推荐的作物。",
        {
          walletBalance: context.walletBalance,
          maxSlots,
        },
      );
    }

    const candidateOptions = await mapWithConcurrency(
      candidateRows,
      APP_CONFIG.marketFetchConcurrency,
      async (row) => buildBalanceCandidate(row, context.marketMap?.get(row.seedId), maxSlots),
    );
    const bestCombination = findBestBalanceCombination(
      candidateOptions.filter((candidate) => candidate.options.length > 0),
      context.walletBalance,
      maxSlots,
      context.sortMode,
    );

    if (!bestCombination) {
      return createBalanceRecommendationMessage(
        BALANCE_RECOMMENDATION_STATUS.noAffordable,
        "当前余额买不起任何1块。",
        {
          walletBalance: context.walletBalance,
          maxSlots,
        },
      );
    }

    return {
      status: BALANCE_RECOMMENDATION_STATUS.ready,
      message: "",
      walletBalance: context.walletBalance,
      maxSlots,
      sortMode: normalizeSortMode(context.sortMode),
      ...bestCombination,
    };
  }

  async function buildBalanceCandidate(row, marketSnapshot, maxSlots) {
    const options = [];
    const maxQuantity =
      row.statusKey === "marketEmptyOfficial"
        ? maxSlots
        : Math.min(maxSlots, Math.max(0, Math.floor(row.marketTotalQuantity)));

    for (let quantity = 1; quantity <= maxQuantity; quantity += 1) {
      let option = null;
      if (row.statusKey === "marketEmptyOfficial") {
        option = buildBalanceOption(row, quantity, row.officialSeedPrice * quantity);
      } else if (row.statusKey === "ok") {
        option = await buildQuotedBalanceOption(row, marketSnapshot?.listings ?? [], quantity);
      }

      if (option) {
        options.push(option);
      }
    }

    return {
      row,
      options,
    };
  }

  async function buildQuotedBalanceOption(row, listings, quantity) {
    if (listings.length === 0) {
      return null;
    }

    const quoteResult = await quotePurchase(listings, quantity);
    if (quoteResult.status !== "ok") {
      return null;
    }

    return buildBalanceOption(row, quantity, quoteResult.buyerPaysTotal);
  }

  function buildBalanceOption(row, quantity, totalCost) {
    if (!Number.isFinite(totalCost) || !Number.isFinite(row.roundSaleAmount) || row.growthSeconds <= 0) {
      return null;
    }

    const totalSaleAmount = row.roundSaleAmount * quantity;
    const totalRoundProfit = totalSaleAmount - totalCost;
    const totalHourlyProfit = totalRoundProfit / (row.growthSeconds / 3600);

    return {
      quantity,
      totalCost,
      totalRoundProfit,
      totalHourlyProfit,
      costPerformance: totalCost > 0 ? totalHourlyProfit / totalCost : null,
      expectedHarvestAt: row.expectedHarvestAt,
    };
  }

  function findBestBalanceCombination(candidates, walletBalance, maxSlots, sortMode) {
    let bestCombination = null;
    const selectedOptions = [];

    function visit(index, totalQuantity, totalCost, totalRoundProfit, totalHourlyProfit) {
      if (totalCost > walletBalance || totalQuantity > maxSlots) {
        return;
      }

      if (index >= candidates.length) {
        if (selectedOptions.length === 0) {
          return;
        }

        const combination = buildBalanceCombination(
          selectedOptions,
          walletBalance,
          maxSlots,
          totalQuantity,
          totalCost,
          totalRoundProfit,
          totalHourlyProfit,
        );

        if (compareBalanceCombination(combination, bestCombination, sortMode) < 0) {
          bestCombination = combination;
        }
        return;
      }

      visit(index + 1, totalQuantity, totalCost, totalRoundProfit, totalHourlyProfit);

      const candidate = candidates[index];
      for (const option of candidate.options) {
        if (totalQuantity + option.quantity > maxSlots || totalCost + option.totalCost > walletBalance) {
          continue;
        }

        selectedOptions.push({
          row: candidate.row,
          ...option,
        });
        visit(
          index + 1,
          totalQuantity + option.quantity,
          totalCost + option.totalCost,
          totalRoundProfit + option.totalRoundProfit,
          totalHourlyProfit + option.totalHourlyProfit,
        );
        selectedOptions.pop();
      }
    }

    visit(0, 0, 0, 0, 0);
    return bestCombination;
  }

  function buildBalanceCombination(items, walletBalance, maxSlots, totalQuantity, totalCost, totalRoundProfit, totalHourlyProfit) {
    const normalizedItems = [...items].sort((left, right) => {
      if (left.quantity !== right.quantity) {
        return right.quantity - left.quantity;
      }
      return left.row.name.localeCompare(right.row.name, "zh-CN");
    });

    return {
      items: normalizedItems,
      totalQuantity,
      totalCost,
      totalRoundProfit,
      totalHourlyProfit,
      costPerformance: totalCost > 0 ? totalHourlyProfit / totalCost : null,
      remainingBalance: walletBalance - totalCost,
      unusedSlots: maxSlots - totalQuantity,
    };
  }

  function compareBalanceCombination(left, right, sortMode) {
    if (!left && !right) {
      return 0;
    }
    if (!left) {
      return 1;
    }
    if (!right) {
      return -1;
    }

    const normalizedSortMode = normalizeSortMode(sortMode);
    if (normalizedSortMode === SORT_MODE.timePriority) {
      const hourlyDiff = compareFiniteDesc(left.totalHourlyProfit, right.totalHourlyProfit);
      if (hourlyDiff !== 0) {
        return hourlyDiff;
      }

      const roundProfitDiff = compareFiniteDesc(left.totalRoundProfit, right.totalRoundProfit);
      if (roundProfitDiff !== 0) {
        return roundProfitDiff;
      }

      const costDiff = compareFiniteAsc(left.totalCost, right.totalCost);
      if (costDiff !== 0) {
        return costDiff;
      }
    } else if (normalizedSortMode === SORT_MODE.singleProfit) {
      const roundProfitDiff = compareFiniteDesc(left.totalRoundProfit, right.totalRoundProfit);
      if (roundProfitDiff !== 0) {
        return roundProfitDiff;
      }

      const hourlyDiff = compareFiniteDesc(left.totalHourlyProfit, right.totalHourlyProfit);
      if (hourlyDiff !== 0) {
        return hourlyDiff;
      }

      const costDiff = compareFiniteAsc(left.totalCost, right.totalCost);
      if (costDiff !== 0) {
        return costDiff;
      }
    } else {
      const ratioDiff = compareFiniteDesc(left.costPerformance, right.costPerformance);
      if (ratioDiff !== 0) {
        return ratioDiff;
      }

      const hourlyDiff = compareFiniteDesc(left.totalHourlyProfit, right.totalHourlyProfit);
      if (hourlyDiff !== 0) {
        return hourlyDiff;
      }

      const costDiff = compareFiniteAsc(left.totalCost, right.totalCost);
      if (costDiff !== 0) {
        return costDiff;
      }
    }

    return buildBalanceSignature(left).localeCompare(buildBalanceSignature(right), "zh-CN");
  }

  function buildBalanceSignature(combination) {
    return combination.items.map((item) => `${item.row.name}:${item.quantity}`).join("|");
  }

  function createBalanceRecommendationMessage(status, message, extra = {}) {
    return {
      status,
      message,
      walletBalance: extra.walletBalance ?? null,
      maxSlots: extra.maxSlots ?? null,
      items: [],
      totalQuantity: 0,
      totalCost: null,
      totalRoundProfit: null,
      totalHourlyProfit: null,
      costPerformance: null,
      remainingBalance: null,
      unusedSlots: null,
    };
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
      sortMode: DEFAULT_SORT_MODE,
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
      sortMode: normalizeSortMode(nextState.sortMode),
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
        setUiState({ open: !uiState.open }, true);
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

    panel.querySelectorAll("[data-sort-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextSortMode = normalizeSortMode(button.getAttribute("data-sort-mode"));
        if (nextSortMode === uiState.sortMode) {
          return;
        }
        setUiState({ sortMode: nextSortMode }, true);
        applyCurrentSortMode();
        void refreshBalanceRecommendation();
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

      .farm-helper-mode-panel {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(104, 137, 91, 0.12);
      }

      .farm-helper-mode-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .farm-helper-mode-button {
        border: 1px solid rgba(91, 139, 69, 0.2);
        border-radius: 999px;
        padding: 9px 14px;
        background: rgba(255, 255, 255, 0.9);
        color: #35502a;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }

      .farm-helper-mode-button.is-active {
        border-color: transparent;
        background: linear-gradient(135deg, #5b8b45, #88b36d);
        color: #fff;
        box-shadow: 0 10px 22px rgba(55, 87, 41, 0.18);
      }

      .farm-helper-mode-desc {
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
        min-width: 1240px;
        font-size: 12px;
      }

      .farm-helper-table.farm-helper-table-compact {
        min-width: 760px;
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
    const sortMode = getSortModeConfig();
    const mainBlock = [
      state.isLoading ? `<div class="farm-helper-state">正在抓接口并计算，请等一下。</div>` : "",
      buildSortModeHtml(sortMode),
      state.error
        ? `<div class="farm-helper-error">数据加载失败：${escapeHtml(state.error)}</div>`
        : [buildRecommendHtml(sortMode), buildBalanceRecommendHtml(sortMode), buildTableHtml(sortMode)].join(""),
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
            <span>先看推荐，再看全表。现在按${escapeHtml(sortMode.label)}排。</span>
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
              性价比 = 每小时利润 / 买1个实际总价。时间优先看每小时利润，单次利润看单轮利润。预计收菜时间 = 本次刷新时间 + 生长时间。按余额推荐会用当前余额和地块数来算组合。菜场没货时按官方价算，菜场顺序不可信，脚本会自己排最低价。
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function buildSortModeHtml(currentSortMode) {
    const buttonsHtml = SORT_MODE_OPTIONS.map((option) => {
      const isActive = option.id === currentSortMode.id;
      return `
        <button
          class="farm-helper-mode-button ${isActive ? "is-active" : ""}"
          type="button"
          data-sort-mode="${escapeHtml(option.id)}"
          aria-pressed="${isActive ? "true" : "false"}"
        >
          ${escapeHtml(option.label)}
        </button>
      `;
    }).join("");

    return `
      <div class="farm-helper-section">
        <div class="farm-helper-mode-panel">
          <div class="farm-helper-section-head">
            <h3>怎么算</h3>
            <span class="farm-helper-tip">刷新后会记住你上次选的算法</span>
          </div>
          <div class="farm-helper-mode-buttons">${buttonsHtml}</div>
          <div class="farm-helper-mode-desc">
            现在用 <strong>${escapeHtml(currentSortMode.label)}</strong>：${escapeHtml(currentSortMode.description)}
          </div>
        </div>
      </div>
    `;
  }

  function buildRecommendHtml(currentSortMode = getSortModeConfig()) {
    if (!state.recommendedRow) {
      return `
        <div class="farm-helper-section">
          <div class="farm-helper-section-head">
            <h3>当前推荐</h3>
            <span class="farm-helper-tip">当前算法：${escapeHtml(currentSortMode.label)}</span>
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
          <span class="farm-helper-tip">当前算法：${escapeHtml(currentSortMode.label)}</span>
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
              <div class="farm-helper-tip">现在用 ${escapeHtml(currentSortMode.label)}：${escapeHtml(currentSortMode.description)}</div>
              <div class="farm-helper-tip">
                生长 ${escapeHtml(formatDuration(row.growthSeconds))}，单块收 ${escapeHtml(String(row.harvestQuantity))} 个，预计 ${escapeHtml(formatDateTime(row.expectedHarvestAt))} 收。
              </div>
            </div>
            <div class="farm-helper-score">
              <span>${escapeHtml(currentSortMode.scoreLabel)}</span>
              <strong>${escapeHtml(getSortMetricText(row, currentSortMode.id))}</strong>
            </div>
          </div>
          <div class="farm-helper-metrics">
            ${buildMetricHtml("性价比", formatRatio(row.costPerformance))}
            ${buildMetricHtml("每小时利润", formatCoin(row.hourlyProfit))}
            ${buildMetricHtml("买1个实际总价", formatPurchase(row.buyOneResult))}
            ${buildMetricHtml("单轮利润", formatCoin(row.roundProfit))}
            ${buildMetricHtml("预计收菜时间", formatDateTime(row.expectedHarvestAt))}
            ${buildMetricHtml("交易所单价", formatCoin(row.recyclePrice))}
            ${buildMetricHtml("菜场最低单价", formatCoin(row.marketMinUnitPrice))}
            ${buildMetricHtml("官方种子单价", formatCoin(row.officialSeedPrice))}
          </div>
        </div>
      </div>
    `;
  }

  function buildBalanceRecommendHtml(currentSortMode = getSortModeConfig()) {
    const recommendation = state.balanceRecommendation;
    const sectionHead = `
      <div class="farm-helper-section-head">
        <h3>按余额推荐</h3>
        <span class="farm-helper-tip">按${escapeHtml(currentSortMode.label)}算整套买法</span>
      </div>
    `;

    if (!recommendation || recommendation.status === BALANCE_RECOMMENDATION_STATUS.loading) {
      return `
        <div class="farm-helper-section">
          ${sectionHead}
          <div class="farm-helper-state">正在按余额算怎么买更合适。</div>
        </div>
      `;
    }

    if (recommendation.status !== BALANCE_RECOMMENDATION_STATUS.ready) {
      return `
        <div class="farm-helper-section">
          ${sectionHead}
          <div class="farm-helper-empty">${escapeHtml(recommendation.message || "现在还算不出余额推荐。")}</div>
        </div>
      `;
    }

    return `
      <div class="farm-helper-section">
        ${sectionHead}
        <div class="farm-helper-recommend">
          <div class="farm-helper-hero">
            <div>
              <div class="farm-helper-name">
                <strong>${escapeHtml(formatBalanceSummary(recommendation))}</strong>
              </div>
              <div class="farm-helper-tip">现在用 ${escapeHtml(currentSortMode.label)}：${escapeHtml(currentSortMode.description)}</div>
              <div class="farm-helper-tip">
                一共买 ${escapeHtml(String(recommendation.totalQuantity))} 块，还空 ${escapeHtml(String(recommendation.unusedSlots))} 块，余额还剩 ${escapeHtml(formatCoin(recommendation.remainingBalance))}。
              </div>
            </div>
            <div class="farm-helper-score">
              <span>${escapeHtml(currentSortMode.scoreLabel)}</span>
              <strong>${escapeHtml(getBalanceSortMetricText(recommendation, currentSortMode.id))}</strong>
            </div>
          </div>
          <div class="farm-helper-metrics">
            ${buildMetricHtml("当前余额", formatCoin(recommendation.walletBalance))}
            ${buildMetricHtml("可种地块数", formatCount(recommendation.maxSlots, "块"))}
            ${buildMetricHtml("组合总购买数", formatCount(recommendation.totalQuantity, "块"))}
            ${buildMetricHtml("实际总花费", formatCoin(recommendation.totalCost))}
            ${buildMetricHtml("剩余余额", formatCoin(recommendation.remainingBalance))}
            ${buildMetricHtml("组合总单轮利润", formatCoin(recommendation.totalRoundProfit))}
            ${buildMetricHtml("组合总每小时利润", formatCoin(recommendation.totalHourlyProfit))}
            ${buildMetricHtml("组合性价比", formatRatio(recommendation.costPerformance))}
            ${buildMetricHtml("未使用地块", formatCount(recommendation.unusedSlots, "块"))}
          </div>
          ${buildBalanceDetailTableHtml(recommendation)}
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

  function buildBalanceDetailTableHtml(recommendation) {
    const rowsHtml = recommendation.items
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.row.name)}</td>
            <td>${escapeHtml(formatCount(item.quantity, "个"))}</td>
            <td>${escapeHtml(formatCoin(item.totalCost))}</td>
            <td>${escapeHtml(formatCoin(item.totalRoundProfit))}</td>
            <td>${escapeHtml(formatCoin(item.totalHourlyProfit))}</td>
            <td>${escapeHtml(formatDateTime(item.expectedHarvestAt))}</td>
          </tr>
        `,
      )
      .join("");

    return `
      <div class="farm-helper-table-wrap">
        <table class="farm-helper-table farm-helper-table-compact">
          <thead>
            <tr>
              <th>作物</th>
              <th>买几个</th>
              <th>这几个的实际总价</th>
              <th>这几个的单轮利润</th>
              <th>这几个的每小时利润</th>
              <th>预计收菜时间</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function buildTableHtml(currentSortMode = getSortModeConfig()) {
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
          <tr class="${row.statusKey === "ok" || row.statusKey === "marketEmptyOfficial" ? "" : "is-dim"}">
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
          <span class="farm-helper-tip">表里有全部信息，现在按${escapeHtml(currentSortMode.label)}排。</span>
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

  function getBalanceSortMetricText(recommendation, sortMode = uiState.sortMode) {
    const normalizedSortMode = normalizeSortMode(sortMode);
    if (normalizedSortMode === SORT_MODE.timePriority) {
      return formatCoin(recommendation.totalHourlyProfit);
    }
    if (normalizedSortMode === SORT_MODE.singleProfit) {
      return formatCoin(recommendation.totalRoundProfit);
    }
    return formatRatio(recommendation.costPerformance);
  }

  function formatBalanceSummary(recommendation) {
    if (recommendation.items.length <= 1) {
      const item = recommendation.items[0];
      return `${item.row.name} x ${formatCount(item.quantity, "个")}`;
    }

    return `${recommendation.items.length}种搭配，买${formatCount(recommendation.totalQuantity, "块")}`;
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

  function formatCount(value, unit) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${value.toLocaleString("zh-CN")}${unit}`;
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
