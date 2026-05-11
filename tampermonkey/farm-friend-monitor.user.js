// ==UserScript==
// @name         农场好友总览助手
// @namespace    hybgzs-farm-helper
// @version      0.1.0
// @description  汇总所有好友当前种植情况，显示成熟时间和偷菜前置判断
// @match        https://cdk.hybgzs.com/entertainment/farm*
// @match        https://cdk.hybgzs.com/entertainment/farm/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const APP_CONFIG = Object.freeze({
    friendApiBaseUrl: "https://cdk.hybgzs.com/api",
    farmApiBaseUrl: "https://cdk.hybgzs.com/api/farm",
    friendsPageLimit: 50,
    friendFetchConcurrency: 4,
    logPageSize: 20,
    maxLogPages: 3,
    soonWindowSeconds: 3600,
    mobileBreakpoint: 900,
    desktopMargin: 16,
    mobileMargin: 12,
    mobileCompactHeightRatio: 0.72,
    mobileExpandedHeightRatio: 0.92,
    launcherBottom: 72,
    defaultWindowWidth: 1120,
    defaultWindowHeight: 780,
    minWindowWidth: 320,
    minWindowHeight: 280,
    panelId: "farm-friend-monitor-panel",
    styleId: "farm-friend-monitor-style",
    launcherId: "farm-friend-monitor-launcher",
    refreshButtonId: "farm-friend-monitor-refresh",
    mobileSizeButtonId: "farm-friend-monitor-mobile-size",
    closeButtonId: "farm-friend-monitor-close",
    windowId: "farm-friend-monitor-window",
    dragHandleId: "farm-friend-monitor-drag-handle",
    storageKey: "farm-friend-monitor-ui-state",
    sessionOpenStateKey: "farm-friend-monitor-open-state",
  });

  const FILTER_OPTIONS = Object.freeze(
    [
      { id: "all", label: "全部批次" },
      { id: "mature", label: "已成熟" },
      { id: "soon", label: "1小时内成熟" },
      { id: "stolen", label: "本轮有人偷过" },
    ].map((option) => Object.freeze(option)),
  );

  const DEFAULT_UI_STATE = Object.freeze({
    open: false,
    filter: "all",
    mobileWindowMode: "compact",
  });

  const MOBILE_WINDOW_MODE = Object.freeze({
    compact: "compact",
    expanded: "expanded",
  });

  const state = {
    isLoading: false,
    error: "",
    updatedAt: "",
    rows: [],
    summary: null,
  };

  const uiState = loadUiState();
  let booted = false;
  let loadToken = 0;
  let resizeObserver = null;
  let dragState = null;
  let expandedRowId = "";

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

  function maybeLoadDataForOpenWindow() {
    if (!uiState.open || state.isLoading || state.updatedAt || state.error) {
      return;
    }
    void loadData();
  }

  async function loadData() {
    if (state.isLoading) {
      return;
    }

    const currentToken = ++loadToken;
    state.isLoading = true;
    state.error = "";
    render();

    try {
      const snapshot = await collectSnapshot();
      if (currentToken !== loadToken) {
        return;
      }
      state.rows = snapshot.rows;
      state.summary = snapshot.summary;
      state.updatedAt = formatTime(snapshot.updatedAt);
      state.error = "";
    } catch (error) {
      if (currentToken !== loadToken) {
        return;
      }
      console.error("[farm-friend-monitor]", error);
      state.rows = [];
      state.summary = null;
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

  async function collectSnapshot() {
    const [seedMap, friends, energyStatus] = await Promise.all([
      fetchSeedMap(),
      fetchAllFriends(),
      fetchEnergyStatus(),
    ]);
    const friendRows = await mapWithConcurrency(friends, APP_CONFIG.friendFetchConcurrency, (friend) =>
      buildFriendRows(friend, seedMap, energyStatus),
    );
    const rows = friendRows.flat().sort(compareRows);
    const updatedAt = new Date();
    return {
      rows,
      summary: buildSummary(rows, friends.length, energyStatus),
      updatedAt,
    };
  }

  async function fetchSeedMap() {
    const response = await requestJson("/api/farm/seeds");
    const seeds = response.seeds ?? [];
    const seedMap = new Map();
    for (const seed of seeds) {
      if (!seed?.id) {
        continue;
      }
      seedMap.set(String(seed.id), {
        id: String(seed.id),
        name: String(seed.name ?? seed.id),
        harvestQuantity: toNullableNumber(seed.harvestQuantity),
      });
    }
    return seedMap;
  }

  async function fetchAllFriends() {
    const friends = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await requestJson(`/api/friends?page=${page}&limit=${APP_CONFIG.friendsPageLimit}`);
      const pageFriends = response.data?.friends ?? [];
      for (const item of pageFriends) {
        const friend = item?.friend;
        const friendId = friend?.id ?? item?.friendId;
        if (!friendId) {
          continue;
        }
        friends.push({
          id: String(friendId),
          username: String(friend?.username ?? "未知好友"),
          avatar: friend?.avatar ?? null,
        });
      }
      hasMore = Boolean(response.data?.pagination?.hasMore);
      page += 1;
    }

    return friends;
  }

  async function fetchEnergyStatus() {
    try {
      const response = await requestJson("/api/farm/energy/status");
      return response.data ?? null;
    } catch (error) {
      console.warn("[farm-friend-monitor] energy-status", error);
      return null;
    }
  }

  async function buildFriendRows(friend, seedMap, energyStatus) {
    try {
      const farm = await fetchFriendFarm(friend.id);
      const crops = normalizeCrops(farm.crops ?? []);
      const activeCrops = crops.filter((crop) => !crop.isHarvested);
      if (activeCrops.length === 0) {
        return [];
      }

      const logs = await fetchFriendLogs(friend.id, getEarliestPlantedAt(activeCrops));
      const groups = groupCrops(activeCrops);
      const seedStats = buildSeedStats(activeCrops, logs, seedMap);
      const anonymousStolenPlotMap = buildAnonymousStolenPlotMap(groups, logs);

      return groups.map((group) =>
        buildRow(friend, group, seedStats.get(group.seedId), energyStatus, anonymousStolenPlotMap.get(group.id) ?? 0),
      );
    } catch (error) {
      console.warn("[farm-friend-monitor] friend", friend.id, error);
      return [];
    }
  }

  async function fetchFriendFarm(friendId) {
    const response = await requestJson(`/api/farm/friends/${encodeURIComponent(friendId)}`);
    return response.data ?? response;
  }

  async function fetchFriendLogs(friendId, earliestPlantedAt) {
    if (!(earliestPlantedAt instanceof Date) || !Number.isFinite(earliestPlantedAt.getTime())) {
      return [];
    }

    try {
      const logs = [];
      let page = 1;
      let hasMore = true;

      while (hasMore && page <= APP_CONFIG.maxLogPages) {
        const response = await requestJson(
          `/api/farm/logs/user/${encodeURIComponent(friendId)}?limit=${APP_CONFIG.logPageSize}&page=${page}`,
        );
        const pageLogs = normalizeLogs(response.data?.logs ?? []);
        logs.push(...pageLogs);
        hasMore = Boolean(response.data?.pagination?.hasMore);
        const oldestLog = pageLogs[pageLogs.length - 1];
        if (!oldestLog || oldestLog.createdAtMs < earliestPlantedAt.getTime()) {
          break;
        }
        page += 1;
      }

      return logs;
    } catch (error) {
      console.warn("[farm-friend-monitor] friend-logs", friendId, error);
      return [];
    }
  }

  function normalizeCrops(crops) {
    return crops
      .map((crop) => {
        const plantedAt = new Date(crop?.plantedAt ?? "");
        const maturesAt = new Date(crop?.maturesAt ?? "");
        const remainingTime = Math.max(0, toNumber(crop?.remainingTime));
        return {
          id: String(crop?.id ?? ""),
          seedId: String(crop?.seedId ?? ""),
          seedName: String(crop?.seedName ?? "未知作物"),
          plantedAt,
          plantedAtMs: plantedAt.getTime(),
          maturesAt,
          maturesAtMs: maturesAt.getTime(),
          isHarvested: Boolean(crop?.isHarvested),
          isMature: Boolean(crop?.isMature) || remainingTime === 0,
          remainingTime,
        };
      })
      .filter((crop) => crop.id && crop.seedId && Number.isFinite(crop.plantedAtMs) && Number.isFinite(crop.maturesAtMs));
  }

  function normalizeLogs(logs) {
    return logs
      .map((log) => {
        const createdAt = new Date(log?.createdAt ?? "");
        return {
          id: String(log?.id ?? ""),
          type: String(log?.type ?? ""),
          title: String(log?.title ?? ""),
          meta: log?.meta ?? {},
          createdAt,
          createdAtMs: createdAt.getTime(),
        };
      })
      .filter((log) => log.id && Number.isFinite(log.createdAtMs));
  }

  function getEarliestPlantedAt(crops) {
    const earliestMs = crops.reduce((result, crop) => Math.min(result, crop.plantedAtMs), Number.POSITIVE_INFINITY);
    return Number.isFinite(earliestMs) ? new Date(earliestMs) : null;
  }

  function buildSeedStats(crops, logs, seedMap) {
    const earliestPlantedAtBySeedId = new Map();
    const seedIdsByName = new Map();
    const seedStats = new Map();

    for (const crop of crops) {
      if (!earliestPlantedAtBySeedId.has(crop.seedId) || earliestPlantedAtBySeedId.get(crop.seedId) > crop.plantedAtMs) {
        earliestPlantedAtBySeedId.set(crop.seedId, crop.plantedAtMs);
      }
      seedIdsByName.set(crop.seedName, crop.seedId);
      const current = seedStats.get(crop.seedId) ?? createEmptySeedStat(seedMap.get(crop.seedId)?.harvestQuantity ?? null);
      current.activePlotCount += 1;
      seedStats.set(crop.seedId, current);
    }

    for (const [seedId, stat] of seedStats) {
      stat.theoreticalTotal =
        Number.isFinite(stat.harvestQuantity) && stat.harvestQuantity !== null ? stat.harvestQuantity * stat.activePlotCount : null;
      seedStats.set(seedId, stat);
    }

    for (const log of logs) {
      if (log.type !== "stolen") {
        continue;
      }
      const seedName = extractSeedName(log.title);
      const seedId = seedIdsByName.get(seedName);
      if (!seedId) {
        continue;
      }
      const earliestPlantedAtMs = earliestPlantedAtBySeedId.get(seedId);
      if (!Number.isFinite(earliestPlantedAtMs) || log.createdAtMs < earliestPlantedAtMs) {
        continue;
      }
      const stat = seedStats.get(seedId) ?? createEmptySeedStat(seedMap.get(seedId)?.harvestQuantity ?? null);
      stat.stolenQuantity += toNumber(log.meta?.totalQuantity);
      stat.stolenPlots += toNumber(log.meta?.plotCount);
      stat.watchdogCount += log.meta?.watchdogTriggered ? 1 : 0;
      stat.eventCount += 1;
      seedStats.set(seedId, stat);
    }

    for (const stat of seedStats.values()) {
      stat.estimatedRemaining =
        Number.isFinite(stat.theoreticalTotal) && stat.theoreticalTotal !== null
          ? Math.max(stat.theoreticalTotal - stat.stolenQuantity, 0)
          : null;
    }

    return seedStats;
  }

  function createEmptySeedStat(harvestQuantity) {
    return {
      harvestQuantity,
      activePlotCount: 0,
      theoreticalTotal: null,
      stolenQuantity: 0,
      stolenPlots: 0,
      watchdogCount: 0,
      eventCount: 0,
      estimatedRemaining: null,
    };
  }

  function extractSeedName(title) {
    const match = /「(.+?)」/.exec(title);
    return match?.[1] ?? "";
  }

  function groupCrops(crops) {
    const groups = new Map();
    for (const crop of crops) {
      const key = buildGroupKey(crop.seedId, crop.maturesAtMs);
      const current = groups.get(key) ?? {
        id: key,
        seedId: crop.seedId,
        seedName: crop.seedName,
        plotCount: 0,
        maturesAtMs: crop.maturesAtMs,
        remainingTime: crop.remainingTime,
        isMature: crop.isMature,
      };
      current.plotCount += 1;
      current.maturesAtMs = Math.max(current.maturesAtMs, crop.maturesAtMs);
      current.remainingTime = Math.min(current.remainingTime, crop.remainingTime);
      current.isMature = current.isMature && crop.isMature;
      groups.set(key, current);
    }
    return [...groups.values()];
  }

  function buildGroupKey(seedId, maturesAtMs) {
    return `${seedId}|${Math.floor(maturesAtMs / 60000)}`;
  }

  function buildAnonymousStolenPlotMap(groups, logs) {
    const allocations = new Map(groups.map((group) => [group.id, 0]));
    const matureGroups = [...groups]
      .filter((group) => group.isMature)
      .sort((left, right) => left.maturesAtMs - right.maturesAtMs);

    for (const log of logs) {
      if (!isAnonymousStolenLog(log)) {
        continue;
      }

      let remainingPlots = Math.max(0, Math.trunc(toNumber(log.meta?.plotCount)));
      if (remainingPlots === 0) {
        continue;
      }

      for (const group of matureGroups) {
        if (group.maturesAtMs > log.createdAtMs) {
          continue;
        }

        const allocatedPlots = allocations.get(group.id) ?? 0;
        const availablePlots = Math.max(group.plotCount - allocatedPlots, 0);
        if (availablePlots === 0) {
          continue;
        }

        const nextAllocation = Math.min(availablePlots, remainingPlots);
        allocations.set(group.id, allocatedPlots + nextAllocation);
        remainingPlots -= nextAllocation;

        if (remainingPlots === 0) {
          break;
        }
      }
    }

    return allocations;
  }

  function isAnonymousStolenLog(log) {
    return log.type === "stolen" && !extractSeedName(log.title) && toNumber(log.meta?.plotCount) > 0;
  }

  function buildRow(friend, group, seedStat, energyStatus, anonymousStolenPlots = 0) {
    const friendStealCost = resolveFriendStealCost(energyStatus);
    const energyReady = canStealFriend(energyStatus, friendStealCost);
    const activePlotCount = seedStat?.activePlotCount ?? group.plotCount;
    const currentRoundStolenPlots = (seedStat?.stolenPlots ?? 0) + anonymousStolenPlots;
    const plotsAvailable = hasAvailablePlots(currentRoundStolenPlots, activePlotCount);
    const quantityAvailable = hasAvailableQuantity(seedStat);
    const canAttempt = group.isMature && energyReady && plotsAvailable && quantityAvailable;
    const status = resolveStatus(group, energyReady, plotsAvailable, quantityAvailable);

    return {
      id: `${friend.id}|${group.seedId}|${group.maturesAtMs}`,
      friendId: friend.id,
      friendName: friend.username,
      friendPageUrl: `/entertainment/farm/friends/${encodeURIComponent(friend.id)}`,
      seedId: group.seedId,
      seedName: group.seedName,
      plotCount: group.plotCount,
      maturesAtMs: group.maturesAtMs,
      remainingTime: group.remainingTime,
      isMature: group.isMature,
      canAttempt,
      statusKey: status.key,
      statusText: status.text,
      currentRoundStolenQuantity: seedStat?.stolenQuantity ?? 0,
      currentRoundStolenPlots,
      currentRoundAnonymousPlots: anonymousStolenPlots,
      currentRoundWatchdogCount: seedStat?.watchdogCount ?? 0,
      currentRoundActivePlots: activePlotCount,
      theoreticalTotal: seedStat?.theoreticalTotal ?? null,
      estimatedRemaining: seedStat?.estimatedRemaining ?? null,
    };
  }

  function hasAvailablePlots(currentRoundStolenPlots, activePlotCount) {
    return currentRoundStolenPlots < activePlotCount;
  }

  function hasAvailableQuantity(seedStat) {
    if (!seedStat || seedStat.estimatedRemaining === null) {
      return true;
    }
    return seedStat.estimatedRemaining > 0;
  }

  function resolveFriendStealCost(energyStatus) {
    if (!energyStatus) {
      return 1;
    }
    if (Number.isFinite(Number(energyStatus.energyCostPerFriendSteal))) {
      return Math.max(1, Math.trunc(Number(energyStatus.energyCostPerFriendSteal)));
    }
    return Math.max(1, Math.ceil(Math.max(1, toNumber(energyStatus.energyCostPerSteal)) / 2));
  }

  function canStealFriend(energyStatus, friendStealCost) {
    if (!energyStatus) {
      return true;
    }
    if (typeof energyStatus.canStealFriend === "boolean") {
      return energyStatus.canStealFriend;
    }
    return toNumber(energyStatus.currentEnergy) >= friendStealCost;
  }

  function resolveStatus(group, energyReady, plotsAvailable, quantityAvailable) {
    if (!group.isMature) {
      return {
        key: "grow",
        text: `${formatDuration(group.remainingTime)}后成熟`,
      };
    }
    if (!plotsAvailable) {
      return {
        key: "done",
        text: "已成熟，这轮地块已偷完",
      };
    }
    if (!quantityAvailable) {
      return {
        key: "done",
        text: "已成熟，理论余量归零",
      };
    }
    if (!energyReady) {
      return {
        key: "warn",
        text: "已成熟，体力稍后恢复",
      };
    }
    return {
      key: "ready",
      text: "已成熟，可尝试偷",
    };
  }

  function buildSummary(rows, friendCount, energyStatus) {
    const matureCount = rows.filter((row) => row.isMature).length;
    const soonCount = rows.filter((row) => !row.isMature && row.remainingTime <= APP_CONFIG.soonWindowSeconds).length;
    const stolenCount = rows.filter(isCurrentRoundStolen).length;
    const friendStealCost = resolveFriendStealCost(energyStatus);
    const energyValue = energyStatus
      ? `${toNumber(energyStatus.currentEnergy)}/${toNumber(energyStatus.maxEnergy)}`
      : "--";
    const energyTip = energyStatus ? `好友每次-${friendStealCost}` : "体力状态稍后刷新";

    return {
      friendCount,
      batchCount: rows.length,
      matureCount,
      soonCount,
      stolenCount,
      energyValue,
      energyTip,
    };
  }

  function compareRows(left, right) {
    if (left.isMature !== right.isMature) {
      return Number(left.isMature) - Number(right.isMature);
    }
    if (left.maturesAtMs !== right.maturesAtMs) {
      return left.isMature ? right.maturesAtMs - left.maturesAtMs : left.maturesAtMs - right.maturesAtMs;
    }
    if (left.canAttempt !== right.canAttempt) {
      return Number(right.canAttempt) - Number(left.canAttempt);
    }
    const friendDiff = left.friendName.localeCompare(right.friendName, "zh-CN");
    if (friendDiff !== 0) {
      return friendDiff;
    }
    return left.seedName.localeCompare(right.seedName, "zh-CN");
  }

  function getFilteredRows() {
    if (uiState.filter === "mature") {
      return state.rows.filter((row) => row.isMature);
    }
    if (uiState.filter === "soon") {
      return state.rows.filter((row) => !row.isMature && row.remainingTime <= APP_CONFIG.soonWindowSeconds);
    }
    if (uiState.filter === "stolen") {
      return state.rows.filter(isCurrentRoundStolen);
    }
    return state.rows;
  }

  function isCurrentRoundStolen(row) {
    return row.currentRoundStolenQuantity > 0 || row.currentRoundStolenPlots > 0;
  }

  function render() {
    const panel = ensurePanel();
    panel.innerHTML = buildPanelHtml();

    const launcherButton = panel.querySelector(`#${APP_CONFIG.launcherId}`);
    if (launcherButton) {
      launcherButton.addEventListener("click", () => {
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

    const mobileSizeButton = panel.querySelector(`#${APP_CONFIG.mobileSizeButtonId}`);
    if (mobileSizeButton) {
      mobileSizeButton.addEventListener("click", () => {
        toggleMobileWindowMode();
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

    panel.querySelectorAll("[data-filter-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const filterId = String(button.getAttribute("data-filter-id") ?? "");
        if (!FILTER_OPTIONS.some((option) => option.id === filterId) || uiState.filter === filterId) {
          return;
        }
        setUiState({ filter: filterId }, true);
        render();
      });
    });

    panel.querySelectorAll("[data-toggle-row-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const rowId = String(button.getAttribute("data-toggle-row-id") ?? "");
        expandedRowId = expandedRowId === rowId ? "" : rowId;
        render();
      });
    });

    panel.querySelectorAll("[data-open-friend-url]").forEach((button) => {
      button.addEventListener("click", () => {
        const friendUrl = button.getAttribute("data-open-friend-url");
        if (friendUrl) {
          openUrlInNewTab(friendUrl);
        }
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
        z-index: 999998;
        pointer-events: none;
        color: #18331b;
        font-family: "Nunito Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      #${APP_CONFIG.panelId} * {
        box-sizing: border-box;
      }

      .friend-monitor-launcher {
        pointer-events: auto;
        position: fixed;
        right: ${APP_CONFIG.desktopMargin}px;
        bottom: ${APP_CONFIG.launcherBottom}px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        background: linear-gradient(135deg, #5c7f30, #96b54a);
        color: #fff;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 16px 34px rgba(48, 71, 23, 0.28);
      }

      .friend-monitor-launcher.is-hidden {
        display: none;
      }

      .friend-monitor-window {
        pointer-events: auto;
        position: fixed;
        min-width: min(${APP_CONFIG.minWindowWidth}px, calc(100vw - ${APP_CONFIG.mobileMargin * 2}px));
        min-height: min(${APP_CONFIG.minWindowHeight}px, calc(100vh - ${APP_CONFIG.mobileMargin * 2}px));
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(91, 131, 67, 0.2);
        border-radius: 22px;
        background:
          radial-gradient(circle at top left, rgba(227, 248, 212, 0.96), rgba(248, 252, 243, 0.94) 48%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(242, 248, 236, 0.96));
        box-shadow: 0 24px 54px rgba(35, 56, 28, 0.2);
        backdrop-filter: blur(12px);
        resize: both;
        overflow: hidden;
      }

      .friend-monitor-window.is-hidden {
        display: none;
      }

      .friend-monitor-window.is-dragging {
        cursor: move;
      }

      .friend-monitor-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 18px;
        border-bottom: 1px solid rgba(101, 131, 83, 0.12);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.66), rgba(236, 246, 228, 0.66));
        cursor: move;
        user-select: none;
        touch-action: none;
      }

      .friend-monitor-title {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .friend-monitor-title strong {
        font-size: 18px;
      }

      .friend-monitor-title span,
      .friend-monitor-tip,
      .friend-monitor-time {
        color: #5c7656;
        font-size: 12px;
      }

      .friend-monitor-actions {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .friend-monitor-button {
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        background: linear-gradient(135deg, #5b8b45, #88b36d);
        color: #fff;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }

      .friend-monitor-button.secondary {
        background: rgba(96, 124, 83, 0.12);
        color: #35502a;
      }

      .friend-monitor-button[disabled] {
        cursor: wait;
        opacity: 0.72;
      }

      .friend-monitor-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        -webkit-overflow-scrolling: touch;
      }

      .friend-monitor-filters,
      .friend-monitor-summary {
        display: grid;
        gap: 12px;
      }

      .friend-monitor-filters {
        grid-template-columns: repeat(auto-fit, minmax(120px, max-content));
      }

      .friend-monitor-filter {
        border: 1px solid rgba(91, 139, 69, 0.18);
        border-radius: 999px;
        padding: 10px 14px;
        background: rgba(255, 255, 255, 0.9);
        color: #35502a;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }

      .friend-monitor-filter.is-active {
        border-color: transparent;
        background: linear-gradient(135deg, #5b8b45, #88b36d);
        color: #fff;
        box-shadow: 0 10px 22px rgba(55, 87, 41, 0.18);
      }

      .friend-monitor-summary {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }

      .friend-monitor-card {
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.82);
        border: 1px solid rgba(104, 137, 91, 0.12);
      }

      .friend-monitor-card span {
        display: block;
        color: #68855f;
        font-size: 12px;
      }

      .friend-monitor-card strong {
        display: block;
        margin-top: 8px;
        font-size: 22px;
        line-height: 1;
      }

      .friend-monitor-card em {
        display: block;
        margin-top: 8px;
        color: #5f7658;
        font-style: normal;
        font-size: 12px;
      }

      .friend-monitor-state,
      .friend-monitor-error,
      .friend-monitor-empty,
      .friend-monitor-footnote {
        padding: 14px 16px;
        border-radius: 14px;
        font-size: 14px;
      }

      .friend-monitor-state {
        background: rgba(89, 127, 70, 0.08);
        color: #476244;
      }

      .friend-monitor-error {
        background: rgba(201, 79, 79, 0.1);
        color: #8c2e2e;
      }

      .friend-monitor-empty {
        background: rgba(112, 128, 87, 0.08);
        color: #607157;
      }

      .friend-monitor-footnote {
        background: rgba(255, 255, 255, 0.72);
        color: #62775c;
      }

      .friend-monitor-table-wrap {
        overflow: auto;
        border-radius: 18px;
        border: 1px solid rgba(111, 146, 89, 0.14);
        background: rgba(255, 255, 255, 0.86);
        -webkit-overflow-scrolling: touch;
        touch-action: pan-x pan-y;
      }

      .friend-monitor-table {
        width: 100%;
        min-width: 920px;
        border-collapse: collapse;
        font-size: 12px;
      }

      .friend-monitor-table thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 10px 8px;
        background: #edf6e9;
        color: #4f6b47;
        text-align: left;
        white-space: nowrap;
      }

      .friend-monitor-table tbody td {
        padding: 10px 8px;
        border-top: 1px solid rgba(101, 131, 83, 0.08);
        vertical-align: middle;
        white-space: nowrap;
      }

      .friend-monitor-table tbody tr:nth-child(odd) {
        background: rgba(249, 252, 245, 0.78);
      }

      .friend-monitor-table tbody tr.is-dim {
        color: #71836c;
      }

      .friend-monitor-name {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .friend-monitor-name strong {
        font-size: 14px;
      }

      .friend-monitor-badge {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
      }

      .friend-monitor-badge.ready {
        background: rgba(65, 137, 83, 0.14);
        color: #1f6e33;
      }

      .friend-monitor-badge.warn {
        background: rgba(201, 144, 51, 0.14);
        color: #956009;
      }

      .friend-monitor-badge.grow {
        background: rgba(84, 115, 187, 0.12);
        color: #36589c;
      }

      .friend-monitor-badge.done {
        background: rgba(96, 107, 120, 0.16);
        color: #4d5968;
      }

      .friend-monitor-link {
        border: 0;
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(91, 139, 69, 0.12);
        color: #35502a;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }

      .friend-monitor-mobile-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .friend-monitor-mobile-card {
        border-radius: 18px;
        border: 1px solid rgba(104, 137, 91, 0.14);
        background: rgba(255, 255, 255, 0.86);
        overflow: hidden;
      }

      .friend-monitor-mobile-card.is-dim {
        color: #71836c;
      }

      .friend-monitor-mobile-toggle {
        width: 100%;
        border: 0;
        padding: 14px;
        background: transparent;
        color: inherit;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        text-align: left;
        cursor: pointer;
      }

      .friend-monitor-mobile-main {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .friend-monitor-mobile-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .friend-monitor-mobile-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        color: #5c7656;
        font-size: 12px;
      }

      .friend-monitor-mobile-chevron {
        flex: 0 0 auto;
        align-self: center;
        color: #5a7154;
        font-size: 12px;
        font-weight: 700;
      }

      .friend-monitor-mobile-details {
        padding: 0 14px 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .friend-monitor-detail-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .friend-monitor-detail-item {
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(248, 252, 244, 0.92);
        border: 1px solid rgba(104, 137, 91, 0.1);
      }

      .friend-monitor-detail-item span {
        display: block;
        margin-bottom: 6px;
        color: #68855f;
        font-size: 11px;
      }

      .friend-monitor-detail-item strong {
        display: block;
        font-size: 13px;
        line-height: 1.4;
        word-break: break-word;
      }

      .friend-monitor-link-row {
        display: flex;
        justify-content: flex-start;
      }

      @media (max-width: ${APP_CONFIG.mobileBreakpoint}px) {
        .friend-monitor-launcher {
          right: ${APP_CONFIG.mobileMargin}px;
          bottom: ${APP_CONFIG.launcherBottom}px;
        }

        .friend-monitor-window {
          resize: none;
          border-radius: 20px;
        }

        .friend-monitor-bar,
        .friend-monitor-actions {
          flex-direction: column;
          align-items: stretch;
        }

        .friend-monitor-body {
          padding: 14px;
          gap: 14px;
        }

        .friend-monitor-filters {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .friend-monitor-summary,
        .friend-monitor-detail-grid {
          grid-template-columns: 1fr;
        }

        .friend-monitor-mobile-head {
          flex-direction: column;
          align-items: stretch;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function buildPanelHtml() {
    const rows = getFilteredRows();
    const mainBlock = [
      buildFilterHtml(),
      buildSummaryHtml(),
      state.isLoading ? `<div class="friend-monitor-state">正在抓好友农场、偷菜日志和体力状态，请等一下。</div>` : "",
      state.error ? `<div class="friend-monitor-error">数据加载失败：${escapeHtml(state.error)}</div>` : buildRowsHtml(rows),
      buildFootnoteHtml(),
    ].join("");

    const mobileSizeButtonHtml = isMobileViewport()
      ? `
            <button id="${APP_CONFIG.mobileSizeButtonId}" class="friend-monitor-button secondary" type="button">
              ${uiState.mobileWindowMode === MOBILE_WINDOW_MODE.expanded ? "半屏" : "全屏"}
            </button>
          `
      : "";

    return `
      <button
        id="${APP_CONFIG.launcherId}"
        class="friend-monitor-launcher ${uiState.open ? "is-hidden" : ""}"
        type="button"
        aria-expanded="${uiState.open ? "true" : "false"}"
      >
        ${uiState.open ? "收起好友总览" : "打开好友总览"}
      </button>
      <div
        id="${APP_CONFIG.windowId}"
        class="friend-monitor-window ${uiState.open ? "" : "is-hidden"}"
        style="${buildWindowStyle()}"
      >
        <div id="${APP_CONFIG.dragHandleId}" class="friend-monitor-bar">
          <div class="friend-monitor-title">
            <strong>好友农场总览</strong>
            <span>当前批次成熟时间、当前轮偷取线索、偷菜前置判断</span>
          </div>
          <div class="friend-monitor-actions">
            <span class="friend-monitor-time">${state.updatedAt ? `更新 ${escapeHtml(state.updatedAt)}` : "还没抓到数据"}</span>
            ${mobileSizeButtonHtml}
            <button id="${APP_CONFIG.refreshButtonId}" class="friend-monitor-button" type="button" ${state.isLoading ? "disabled" : ""}>
              ${state.isLoading ? "刷新中..." : "刷新"}
            </button>
            <button id="${APP_CONFIG.closeButtonId}" class="friend-monitor-button secondary" type="button">
              关闭
            </button>
          </div>
        </div>
        <div class="friend-monitor-body">${mainBlock}</div>
      </div>
    `;
  }

  function buildFilterHtml() {
    const buttonsHtml = FILTER_OPTIONS.map((option) => {
      const isActive = option.id === uiState.filter;
      return `
        <button
          type="button"
          class="friend-monitor-filter ${isActive ? "is-active" : ""}"
          data-filter-id="${escapeHtml(option.id)}"
          aria-pressed="${isActive ? "true" : "false"}"
        >
          ${escapeHtml(option.label)}
        </button>
      `;
    }).join("");
    return `<div class="friend-monitor-filters">${buttonsHtml}</div>`;
  }

  function buildSummaryHtml() {
    if (!state.summary) {
      return "";
    }
    return `
      <div class="friend-monitor-summary">
        ${buildSummaryCard("好友数", String(state.summary.friendCount), "已抓好友列表总数")}
        ${buildSummaryCard("批次数", String(state.summary.batchCount), "同种且同一分钟成熟的地块会合并成一批")}
        ${buildSummaryCard("已成熟", String(state.summary.matureCount), "当前已经成熟的批次")}
        ${buildSummaryCard("1小时内成熟", String(state.summary.soonCount), "方便卡点去偷")}
        ${buildSummaryCard("本轮有人偷过", String(state.summary.stolenCount), "当前轮日志已经出现偷取记录的批次")}
        ${buildSummaryCard("当前体力", state.summary.energyValue, state.summary.energyTip)}
      </div>
    `;
  }

  function buildSummaryCard(label, value, tip) {
    return `
      <div class="friend-monitor-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <em>${escapeHtml(tip)}</em>
      </div>
    `;
  }

  function buildRowsHtml(rows) {
    syncExpandedRowId(rows);
    return isMobileViewport() ? buildMobileListHtml(rows) : buildTableHtml(rows);
  }

  function syncExpandedRowId(rows) {
    if (expandedRowId && !rows.some((row) => row.id === expandedRowId)) {
      expandedRowId = "";
    }
  }

  function buildMobileListHtml(rows) {
    if (rows.length === 0 && !state.isLoading) {
      return `<div class="friend-monitor-empty">当前筛选下还没有可展示的好友批次。</div>`;
    }

    return `<div class="friend-monitor-mobile-list">${rows.map((row) => buildMobileCardHtml(row)).join("")}</div>`;
  }

  function buildMobileCardHtml(row) {
    const clueText = buildClueText(row);
    const isExpanded = expandedRowId === row.id;
    const detailBlock = isExpanded
      ? `
          <div class="friend-monitor-mobile-details">
            <div class="friend-monitor-detail-grid">
              ${buildDetailItemHtml("好友", row.friendName)}
              ${buildDetailItemHtml("好友标识", row.friendId.slice(0, 8))}
              ${buildDetailItemHtml("作物", row.seedName)}
              ${buildDetailItemHtml("地块", `${row.plotCount} 块`)}
              ${buildDetailItemHtml("状态", row.statusText)}
              ${buildDetailItemHtml("成熟时间", formatDateTime(row.maturesAtMs))}
              ${buildDetailItemHtml("当前轮线索", clueText)}
            </div>
            <div class="friend-monitor-link-row">
              <button type="button" class="friend-monitor-link" data-open-friend-url="${escapeHtml(row.friendPageUrl)}">
                打开好友页
              </button>
            </div>
          </div>
        `
      : "";

    return `
      <article class="friend-monitor-mobile-card ${row.isMature ? "" : "is-dim"}">
        <button
          type="button"
          class="friend-monitor-mobile-toggle"
          data-toggle-row-id="${escapeHtml(row.id)}"
          aria-expanded="${isExpanded ? "true" : "false"}"
        >
          <div class="friend-monitor-mobile-main">
            <div class="friend-monitor-mobile-head">
              <div class="friend-monitor-name">
                <strong>${escapeHtml(row.friendName)}</strong>
                <span class="friend-monitor-tip">${escapeHtml(row.seedName)}</span>
              </div>
              <span class="friend-monitor-badge ${escapeHtml(row.statusKey)}">${escapeHtml(row.statusText)}</span>
            </div>
            <div class="friend-monitor-mobile-meta">
              <span>${escapeHtml(`${row.plotCount} 块`)}</span>
              <span>${escapeHtml(formatDateTime(row.maturesAtMs))}</span>
            </div>
          </div>
          <span class="friend-monitor-mobile-chevron">${isExpanded ? "收起详情" : "展开详情"}</span>
        </button>
        ${detailBlock}
      </article>
    `;
  }

  function buildDetailItemHtml(label, value) {
    return `
      <div class="friend-monitor-detail-item">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function buildTableHtml(rows) {
    if (rows.length === 0 && !state.isLoading) {
      return `<div class="friend-monitor-empty">当前筛选下还没有可展示的好友批次。</div>`;
    }

    const rowsHtml = rows
      .map((row) => {
        const clueText = buildClueText(row);
        return `
          <tr class="${row.isMature ? "" : "is-dim"}">
            <td>
              <div class="friend-monitor-name">
                <strong>${escapeHtml(row.friendName)}</strong>
                <span class="friend-monitor-tip">${escapeHtml(row.friendId.slice(0, 8))}</span>
              </div>
            </td>
            <td>${escapeHtml(row.seedName)}</td>
            <td>${escapeHtml(`${row.plotCount} 块`)}</td>
            <td><span class="friend-monitor-badge ${escapeHtml(row.statusKey)}">${escapeHtml(row.statusText)}</span></td>
            <td>${escapeHtml(formatDateTime(row.maturesAtMs))}</td>
            <td title="理论余量 = 当前同种未收地块总产量 - 当前轮日志偷取量">${escapeHtml(clueText)}</td>
            <td>
              <button type="button" class="friend-monitor-link" data-open-friend-url="${escapeHtml(row.friendPageUrl)}">
                打开好友页
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="friend-monitor-table-wrap">
        <table class="friend-monitor-table">
          <thead>
            <tr>
              <th>好友</th>
              <th>作物</th>
              <th>地块</th>
              <th>状态</th>
              <th>成熟时间</th>
              <th>当前轮线索</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function buildClueText(row) {
    const parts = [`偷 ${row.currentRoundStolenQuantity}`, `地 ${row.currentRoundStolenPlots}/${row.currentRoundActivePlots}`];
    if (row.currentRoundAnonymousPlots > 0) {
      parts.push(`混 ${row.currentRoundAnonymousPlots}`);
    }
    if (row.currentRoundWatchdogCount > 0) {
      parts.push(`狗 ${row.currentRoundWatchdogCount}`);
    }
    if (Number.isFinite(row.theoreticalTotal) && row.theoreticalTotal !== null) {
      parts.push(`约余 ${row.estimatedRemaining}/${row.theoreticalTotal}`);
    } else {
      parts.push("约余 --");
    }
    return parts.join(" / ");
  }

  function buildFootnoteHtml() {
    return `
      <div class="friend-monitor-footnote">
        精确是否偷得到，由 <code>/api/farm/steal/friend</code> 在服务端判定。这个面板把成熟状态、当前轮偷取日志和同种理论余量放在一起看，适合先筛人，再点进好友页下手。
      </div>
    `;
  }

  function loadUiState() {
    const defaultState = createDefaultWindowState();
    try {
      const rawValue = localStorage.getItem(APP_CONFIG.storageKey);
      return normalizeUiState({
        ...defaultState,
        ...(rawValue ? JSON.parse(rawValue) : {}),
        open: loadOpenState(),
      });
    } catch (error) {
      console.warn("[farm-friend-monitor] load-ui-state", error);
      return defaultState;
    }
  }

  function isMobileViewport() {
    return window.innerWidth <= APP_CONFIG.mobileBreakpoint;
  }

  function normalizeMobileWindowMode(modeValue) {
    return modeValue === MOBILE_WINDOW_MODE.expanded ? MOBILE_WINDOW_MODE.expanded : MOBILE_WINDOW_MODE.compact;
  }

  function resolveMobileWindowHeight(modeValue) {
    const heightRatio =
      normalizeMobileWindowMode(modeValue) === MOBILE_WINDOW_MODE.expanded
        ? APP_CONFIG.mobileExpandedHeightRatio
        : APP_CONFIG.mobileCompactHeightRatio;
    return Math.round(getAvailableWindowHeight() * heightRatio);
  }

  function createDefaultWindowState() {
    const margin = getViewportMargin();
    if (isMobileViewport()) {
      const width = getAvailableWindowWidth();
      const height = clamp(
        resolveMobileWindowHeight(DEFAULT_UI_STATE.mobileWindowMode),
        Math.min(APP_CONFIG.minWindowHeight, getAvailableWindowHeight()),
        getAvailableWindowHeight(),
      );
      return {
        ...DEFAULT_UI_STATE,
        left: margin,
        top: Math.max(margin, window.innerHeight - height - margin),
        width,
        height,
      };
    }

    const width = Math.min(APP_CONFIG.defaultWindowWidth, getAvailableWindowWidth());
    const height = Math.min(APP_CONFIG.defaultWindowHeight, getAvailableWindowHeight());
    const left = Math.max(margin, window.innerWidth - width - margin);

    return {
      ...DEFAULT_UI_STATE,
      left,
      top: margin,
      width,
      height,
    };
  }

  function normalizeUiState(nextState) {
    const defaultState = createDefaultWindowState();
    const margin = getViewportMargin();
    const availableWidth = getAvailableWindowWidth();
    const availableHeight = getAvailableWindowHeight();
    const mobileWindowMode = normalizeMobileWindowMode(nextState.mobileWindowMode);
    const minWidth = Math.min(APP_CONFIG.minWindowWidth, availableWidth);
    const minHeight = Math.min(APP_CONFIG.minWindowHeight, availableHeight);

    if (isMobileViewport()) {
      const height = clamp(resolveMobileWindowHeight(mobileWindowMode), minHeight, availableHeight);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);

      return {
        open: Boolean(nextState.open),
        filter: normalizeFilter(nextState.filter),
        mobileWindowMode,
        left: margin,
        top: clamp(toFiniteNumber(nextState.top, defaultState.top), margin, maxTop),
        width: availableWidth,
        height,
      };
    }

    const width = clamp(toFiniteNumber(nextState.width, defaultState.width), minWidth, availableWidth);
    const height = clamp(toFiniteNumber(nextState.height, defaultState.height), minHeight, availableHeight);
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    return {
      open: Boolean(nextState.open),
      filter: normalizeFilter(nextState.filter),
      mobileWindowMode,
      left: clamp(toFiniteNumber(nextState.left, defaultState.left), margin, maxLeft),
      top: clamp(toFiniteNumber(nextState.top, defaultState.top), margin, maxTop),
      width,
      height,
    };
  }

  function normalizeFilter(filterValue) {
    return FILTER_OPTIONS.some((option) => option.id === filterValue) ? filterValue : DEFAULT_UI_STATE.filter;
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
      localStorage.setItem(
        APP_CONFIG.storageKey,
        JSON.stringify({
          filter: uiState.filter,
          mobileWindowMode: uiState.mobileWindowMode,
          left: uiState.left,
          top: uiState.top,
          width: uiState.width,
          height: uiState.height,
        }),
      );
    } catch (error) {
      console.warn("[farm-friend-monitor] save-ui-state", error);
    }

    saveOpenState(uiState.open);
  }

  function loadOpenState() {
    try {
      return sessionStorage.getItem(APP_CONFIG.sessionOpenStateKey) === "1";
    } catch (error) {
      console.warn("[farm-friend-monitor] load-open-state", error);
      return DEFAULT_UI_STATE.open;
    }
  }

  function saveOpenState(isOpen) {
    try {
      if (isOpen) {
        sessionStorage.setItem(APP_CONFIG.sessionOpenStateKey, "1");
        return;
      }
      sessionStorage.removeItem(APP_CONFIG.sessionOpenStateKey);
    } catch (error) {
      console.warn("[farm-friend-monitor] save-open-state", error);
    }
  }

  function openUrlInNewTab(path) {
    const popupWindow = window.open(path, "_blank", "noopener,noreferrer");
    if (popupWindow) {
      popupWindow.opener = null;
      return;
    }
    window.location.href = path;
  }

  function getViewportMargin() {
    return isMobileViewport() ? APP_CONFIG.mobileMargin : APP_CONFIG.desktopMargin;
  }

  function getAvailableWindowWidth() {
    return Math.max(0, window.innerWidth - getViewportMargin() * 2);
  }

  function getAvailableWindowHeight() {
    return Math.max(0, window.innerHeight - getViewportMargin() * 2);
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

  function toggleMobileWindowMode() {
    if (!isMobileViewport()) {
      return;
    }

    const nextMode =
      uiState.mobileWindowMode === MOBILE_WINDOW_MODE.expanded
        ? MOBILE_WINDOW_MODE.compact
        : MOBILE_WINDOW_MODE.expanded;
    const nextHeight = clamp(
      resolveMobileWindowHeight(nextMode),
      Math.min(APP_CONFIG.minWindowHeight, getAvailableWindowHeight()),
      getAvailableWindowHeight(),
    );
    const margin = getViewportMargin();
    const currentBottom = uiState.top + uiState.height;
    const maxTop = Math.max(margin, window.innerHeight - nextHeight - margin);
    const nextTop = clamp(currentBottom - nextHeight, margin, maxTop);

    setUiState(
      {
        mobileWindowMode: nextMode,
        top: nextTop,
      },
      true,
    );
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
    if (event.pointerType !== "touch" && event.button !== 0) {
      return;
    }
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }

    const rect = windowElement.getBoundingClientRect();
    dragState = {
      isMobile: isMobileViewport(),
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    windowElement.classList.add("is-dragging");
    document.body.style.userSelect = "none";
    if (event.currentTarget instanceof Element && event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  }

  function handleWindowDragMove(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const nextPosition = dragState.isMobile
      ? {
          top: event.clientY - dragState.offsetY,
        }
      : {
          left: event.clientX - dragState.offsetX,
          top: event.clientY - dragState.offsetY,
        };

    setUiState(nextPosition, false);
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

  async function requestJson(path, options = {}) {
    const requestUrl = buildRequestUrl(path);
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
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`);
    }
    if (payload && payload.success === false) {
      throw new Error(payload.error?.message || payload.message || "接口失败");
    }
    return payload;
  }

  function buildRequestUrl(path) {
    if (path.startsWith("http")) {
      return path;
    }
    if (path.startsWith("/api/farm")) {
      return `${APP_CONFIG.friendApiBaseUrl}${path.slice(4)}`;
    }
    if (path.startsWith("/api/")) {
      return `${APP_CONFIG.friendApiBaseUrl}${path.slice(4)}`;
    }
    return `${APP_CONFIG.farmApiBaseUrl}${path}`;
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

  function toFiniteNumber(value, fallbackValue) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallbackValue;
  }

  function clamp(value, minValue, maxValue) {
    return Math.min(Math.max(value, minValue), maxValue);
  }

  function toNullableNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return "未知错误";
  }
})();
