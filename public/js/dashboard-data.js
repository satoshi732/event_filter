(() => {
  function isSearchParamsLike(value) {
    return Boolean(value) && typeof value.get === 'function';
  }

  function queryOrDefault(queryOrKey, keyOrFallback, fallbackOrAllowedValues, maybeAllowedValues) {
    const query = isSearchParamsLike(queryOrKey)
      ? queryOrKey
      : new URLSearchParams(window.location.search);
    const key = isSearchParamsLike(queryOrKey) ? keyOrFallback : queryOrKey;
    const fallback = isSearchParamsLike(queryOrKey) ? fallbackOrAllowedValues : keyOrFallback;
    const allowedValues = isSearchParamsLike(queryOrKey) ? maybeAllowedValues : fallbackOrAllowedValues;
    const value = query.get(key);
    if (value == null || value === '') return fallback;
    if (Array.isArray(allowedValues) && !allowedValues.includes(value)) return fallback;
    return value;
  }

  function routeValueOrDefault(value, fallback, allowedValues) {
    if (value == null || value === '') return fallback;
    if (Array.isArray(allowedValues) && !allowedValues.includes(value)) return fallback;
    return value;
  }

  function readJsonStorage(storage, key, fallback) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJsonStorage(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore storage failures
    }
  }

  function countSettingLines(value) {
    if (Array.isArray(value)) return value.filter(Boolean).length;
    return String(value || '')
      .split(/[\r\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .length;
  }

  function normalizeChainConfigRow(row = {}) {
    const nativeCurrency = row.native_currency && typeof row.native_currency === 'object'
      ? row.native_currency
      : {};
    return {
      chain: String(row.chain || '').trim().toLowerCase(),
      name: String(row.name || '').trim(),
      chain_id: Number.isFinite(Number(row.chain_id)) ? Number(row.chain_id) : '',
      table_prefix: String(row.table_prefix || '').trim(),
      blocks_per_scan: Number.isFinite(Number(row.blocks_per_scan)) ? Number(row.blocks_per_scan) : 75,
      pipeline_source: String(row.pipeline_source || '').trim().toLowerCase() === 'rpc' ? 'rpc' : 'chainbase',
      rpc_network: String(row.rpc_network || '').trim(),
      multicall3: String(row.multicall3 || '').trim().toLowerCase(),
      wrapped_native_token_address: String(row.wrapped_native_token_address || '').trim().toLowerCase(),
      native_currency_name: String(row.native_currency_name || nativeCurrency.name || '').trim(),
      native_currency_symbol: String(row.native_currency_symbol || nativeCurrency.symbol || '').trim(),
      native_currency_decimals: Number.isFinite(Number(row.native_currency_decimals ?? nativeCurrency.decimals))
        ? Number(row.native_currency_decimals ?? nativeCurrency.decimals)
        : 18,
    };
  }

  function normalizeAllowedChains(value) {
    return Array.isArray(value)
      ? value.map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean)
      : [];
  }

  function buildVisibleChainsForAccount(account = {}) {
    const availableChains = normalizeAllowedChains(account.available_chains);
    const selectedChains = normalizeAllowedChains(account.allowed_chains);
    return selectedChains.length ? selectedChains : availableChains;
  }

  function normalizeAutoAnalysisChainRatios(value, selectedChains) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(
      selectedChains.map((chain) => {
        const parsed = Number(source[chain]);
        return [chain, Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 100];
      }),
    );
  }

  function normalizeAutoAnalysisChainConfigs(value, selectedChains) {
    const source = value && typeof value === 'object' ? value : {};
    const normalizeBlockField = (input) => {
      const normalized = String(input ?? '').trim();
      return /^\d+$/.test(normalized) ? normalized : '';
    };
    const normalizePercent = (input, fallback) => {
      const parsed = Number(input);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.max(0, Math.min(100, Math.floor(parsed))) : fallback;
    };
    return Object.fromEntries(
      selectedChains.map((chain) => {
        const row = source[chain] && typeof source[chain] === 'object' ? source[chain] : {};
        return [chain, {
          from_block: normalizeBlockField(row.from_block ?? row.fromBlock),
          to_block: normalizeBlockField(row.to_block ?? row.toBlock),
          delta_blocks: normalizeBlockField(row.delta_blocks ?? row.deltaBlocks),
          token_share_percent: normalizePercent(row.token_share_percent ?? row.tokenSharePercent, 40),
          contract_share_percent: normalizePercent(row.contract_share_percent ?? row.contractSharePercent, 60),
        }];
      }),
    );
  }

  function normalizeAutoAnalysisConfig(config = {}, availableChains = []) {
    const selectedChains = normalizeAllowedChains(config.selected_chains)
      .filter((chain) => !availableChains.length || availableChains.includes(chain));
    const chainRatios = normalizeAutoAnalysisChainRatios(config.chain_ratios, selectedChains);
    return {
      ...config,
      selected_chains: selectedChains,
      chain_ratios: chainRatios,
      chain_configs: normalizeAutoAnalysisChainConfigs(config.chain_configs ?? config.chainConfigs, selectedChains),
      chain_candidate: availableChains.find((chain) => !selectedChains.includes(chain)) || '',
    };
  }

  function normalizeAutoAnalysisStatus(status = {}, availableChains = []) {
    const normalizedChains = normalizeAllowedChains(status.chains || status.selected_chains)
      .filter((chain) => !availableChains.length || availableChains.includes(chain));
    return {
      enabled: Boolean(status.enabled),
      stopping: Boolean(status.stopping),
      chain: String(status.chain || '').trim().toLowerCase() || null,
      chains: normalizedChains,
      chain_ratios: normalizeAutoAnalysisChainRatios(status.chain_ratios || status.chainRatios, normalizedChains),
      phase: String(status.phase || 'idle'),
      queued: Number(status.queued) || 0,
      active: Number(status.active) || 0,
      capacity: Number(status.capacity) || 10,
      cycle: Number(status.cycle) || 0,
      queuedThisRound: Number(status.queuedThisRound ?? status.queued_this_round) || 0,
      runningThisRound: Number(status.runningThisRound ?? status.running_this_round) || 0,
      completedThisRound: Number(status.completedThisRound ?? status.completed_this_round) || 0,
      failedThisRound: Number(status.failedThisRound ?? status.failed_this_round) || 0,
      lastAction: String(status.lastAction || status.last_action || 'Auto analysis is idle'),
      updatedAt: status.updatedAt || status.updated_at || null,
    };
  }

  function normalizeDashboardHome(data = {}) {
    const normalizeDate = (value) => {
      const normalized = String(value || '').trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
    };
    const normalizeCount = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
    };
    return {
      username: String(data.username || '').trim().toLowerCase(),
      activity_series: Array.isArray(data.activity_series)
        ? data.activity_series.map((row) => ({
          date: normalizeDate(row?.date),
          sync_pattern_count: normalizeCount(row?.sync_pattern_count),
          review_count: normalizeCount(row?.review_count),
          auto_analysis_count: normalizeCount(row?.auto_analysis_count),
        })).filter((row) => row.date)
        : [],
      global_sync_series: Array.isArray(data.global_sync_series)
        ? data.global_sync_series.map((row) => ({
          date: normalizeDate(row?.date),
          count: normalizeCount(row?.count),
        })).filter((row) => row.date)
        : [],
      inventory: {
        contracts_total: normalizeCount(data.inventory?.contracts_total),
        contracts_analyzed: normalizeCount(data.inventory?.contracts_analyzed),
        tokens_total: normalizeCount(data.inventory?.tokens_total),
        tokens_analyzed: normalizeCount(data.inventory?.tokens_analyzed),
      },
      daily_assign: {
        target: normalizeCount(data.daily_assign?.target) || 200,
        review_count: normalizeCount(data.daily_assign?.review_count),
        percent: Math.max(0, Math.min(100, normalizeCount(data.daily_assign?.percent))),
      },
      auto_status: {
        enabled: Boolean(data.auto_status?.enabled),
        phase: String(data.auto_status?.phase || 'idle'),
        chain: String(data.auto_status?.chain || '').trim().toLowerCase() || null,
        queued: normalizeCount(data.auto_status?.queued),
        running: normalizeCount(data.auto_status?.running),
        completed: normalizeCount(data.auto_status?.completed),
        failed: normalizeCount(data.auto_status?.failed),
        capacity: normalizeCount(data.auto_status?.capacity),
        cycle: normalizeCount(data.auto_status?.cycle),
        last_action: String(data.auto_status?.last_action || data.auto_status?.lastAction || 'Auto analysis is idle'),
        updated_at: data.auto_status?.updated_at || data.auto_status?.updatedAt || null,
      },
    };
  }

  function formatDashboardDateLabel(value) {
    const normalized = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '--';
    return normalized.slice(5).replace('-', '/');
  }

  function buildDashboardChartBase() {
    return {
      animation: true,
      textStyle: {
        fontFamily: 'Space Grotesk, sans-serif',
      },
      grid: {
        left: 14,
        right: 14,
        top: 22,
        bottom: 18,
        containLabel: true,
      },
    };
  }

  function buildDashboardTooltip() {
    return {
      trigger: 'axis',
      backgroundColor: 'rgba(8, 16, 28, 0.96)',
      borderColor: 'rgba(112, 180, 255, 0.18)',
      borderWidth: 1,
      textStyle: {
        color: '#ecf4ff',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      extraCssText: 'box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35); border-radius: 14px; padding: 10px 12px;',
    };
  }

  function buildDashboardActivityChartOption(activitySeries = []) {
    return {
      ...buildDashboardChartBase(),
      color: ['#18d7c5', '#5f7dff', '#ff9b52'],
      tooltip: {
        ...buildDashboardTooltip(),
        trigger: 'axis',
      },
      legend: { show: false },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: activitySeries.map((row) => formatDashboardDateLabel(row.date)),
        axisLine: {
          lineStyle: { color: 'rgba(140, 196, 255, 0.28)' },
        },
        axisTick: { show: false },
        axisLabel: {
          color: 'rgba(201, 219, 240, 0.68)',
          fontSize: 10,
          margin: 12,
        },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitNumber: 3,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: 'rgba(201, 219, 240, 0.58)',
          fontSize: 10,
        },
        splitLine: {
          lineStyle: {
            color: 'rgba(140, 196, 255, 0.12)',
            type: 'dashed',
          },
        },
      },
      series: [
        {
          name: 'Sync',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 7,
          showSymbol: activitySeries.length <= 12,
          lineStyle: { width: 3, color: '#18d7c5' },
          itemStyle: { color: '#18d7c5', borderColor: '#06111f', borderWidth: 2 },
          areaStyle: { color: 'rgba(24, 215, 197, 0.12)' },
          data: activitySeries.map((row) => Number(row.sync_pattern_count || 0)),
        },
        {
          name: 'Review',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 7,
          showSymbol: activitySeries.length <= 12,
          lineStyle: { width: 3, color: '#5f7dff' },
          itemStyle: { color: '#5f7dff', borderColor: '#06111f', borderWidth: 2 },
          areaStyle: { color: 'rgba(95, 125, 255, 0.10)' },
          data: activitySeries.map((row) => Number(row.review_count || 0)),
        },
        {
          name: 'Auto',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 7,
          showSymbol: activitySeries.length <= 12,
          lineStyle: { width: 3, color: '#ff9b52' },
          itemStyle: { color: '#ff9b52', borderColor: '#06111f', borderWidth: 2 },
          areaStyle: { color: 'rgba(255, 155, 82, 0.10)' },
          data: activitySeries.map((row) => Number(row.auto_analysis_count || 0)),
        },
      ],
    };
  }

  function buildDashboardGlobalSyncBars(globalSyncSeries = []) {
    return globalSyncSeries.map((row) => ({
      ...row,
      label: formatDashboardDateLabel(row.date),
      count: Number(row.count || 0),
    }));
  }

  function buildDashboardGlobalSyncChartOption(globalSyncBars = []) {
    return {
      ...buildDashboardChartBase(),
      color: ['#18d7c5'],
      tooltip: {
        ...buildDashboardTooltip(),
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
      },
      grid: {
        left: 10,
        right: 10,
        top: 22,
        bottom: 18,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: globalSyncBars.map((row) => row.label),
        axisLine: {
          lineStyle: { color: 'rgba(140, 196, 255, 0.2)' },
        },
        axisTick: { show: false },
        axisLabel: {
          color: 'rgba(201, 219, 240, 0.68)',
          fontSize: 10,
          margin: 10,
        },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: 'rgba(201, 219, 240, 0.58)',
          fontSize: 10,
        },
        splitLine: {
          lineStyle: {
            color: 'rgba(140, 196, 255, 0.1)',
            type: 'dashed',
          },
        },
      },
      series: [{
        name: 'Syncs',
        type: 'bar',
        barWidth: '44%',
        itemStyle: {
          color: '#18d7c5',
          borderRadius: [10, 10, 4, 4],
          shadowBlur: 18,
          shadowColor: 'rgba(24, 215, 197, 0.22)',
        },
        emphasis: {
          itemStyle: {
            color: '#39e7d2',
          },
        },
        data: globalSyncBars.map((row) => row.count),
      }],
    };
  }

  function buildDashboardCoverageCards(inventory = {}) {
    return [
      {
        key: 'contracts',
        label: 'Contracts',
        analyzed: Number(inventory.contracts_analyzed || 0),
        total: Number(inventory.contracts_total || 0),
        tone: 'contracts',
      },
      {
        key: 'tokens',
        label: 'Tokens',
        analyzed: Number(inventory.tokens_analyzed || 0),
        total: Number(inventory.tokens_total || 0),
        tone: 'tokens',
      },
    ].map((row) => ({
      ...row,
      percent: row.total > 0 ? Math.max(0, Math.min(100, Math.round((row.analyzed / row.total) * 100))) : 0,
    }));
  }

  function buildDashboardAutoEngineChartOption(autoSummary = {}) {
    const queued = Number(autoSummary.queued || 0);
    const running = Number(autoSummary.running || 0);
    const completed = Number(autoSummary.completed || 0);
    const failed = Number(autoSummary.failed || 0);
    const total = queued + running + completed + failed;
    const segments = [
      { key: 'queued', label: 'Queued', value: queued, color: '#5f7dff' },
      { key: 'running', label: 'Running', value: running, color: '#18d7c5' },
      { key: 'completed', label: 'Success', value: completed, color: '#29d07f' },
      { key: 'failed', label: 'Failed', value: failed, color: '#ff7a7a' },
    ];
    return {
      animation: true,
      color: segments.map((segment) => segment.color),
      tooltip: {
        ...buildDashboardTooltip(),
        trigger: 'item',
        formatter: ({ name, value, percent }) => `${name}: ${value} (${percent}%)`,
      },
      title: {
        text: total > 0 ? `${total}` : '--',
        subtext: total > 0 ? 'events' : 'idle',
        left: 'center',
        top: '39%',
        textAlign: 'center',
        textStyle: {
          color: '#f2f7ff',
          fontSize: 24,
          fontWeight: 700,
          fontFamily: 'Space Grotesk, sans-serif',
        },
        subtextStyle: {
          color: 'rgba(201, 219, 240, 0.64)',
          fontSize: 11,
          fontWeight: 500,
          fontFamily: 'JetBrains Mono, monospace',
          textTransform: 'uppercase',
        },
      },
      series: [{
        name: 'Auto Engine',
        type: 'pie',
        radius: ['68%', '84%'],
        center: ['50%', '50%'],
        startAngle: 90,
        clockwise: true,
        avoidLabelOverlap: false,
        silent: false,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: {
          borderColor: '#09141d',
          borderWidth: 4,
        },
        data: total > 0
          ? segments.map((segment) => ({
            name: segment.label,
            value: segment.value,
            itemStyle: { color: segment.color },
          }))
          : [{
            name: 'Idle',
            value: 1,
            itemStyle: { color: 'rgba(112, 180, 255, 0.12)' },
          }],
      }],
    };
  }

  window.EventFilterDashboardData = {
    queryOrDefault,
    routeValueOrDefault,
    readJsonStorage,
    writeJsonStorage,
    countSettingLines,
    normalizeChainConfigRow,
    normalizeAllowedChains,
    buildVisibleChainsForAccount,
    normalizeAutoAnalysisChainRatios,
    normalizeAutoAnalysisChainConfigs,
    normalizeAutoAnalysisConfig,
    normalizeAutoAnalysisStatus,
    normalizeDashboardHome,
    formatDashboardDateLabel,
    buildDashboardChartBase,
    buildDashboardTooltip,
    buildDashboardActivityChartOption,
    buildDashboardGlobalSyncBars,
    buildDashboardGlobalSyncChartOption,
    buildDashboardCoverageCards,
    buildDashboardAutoEngineChartOption,
  };
})();
