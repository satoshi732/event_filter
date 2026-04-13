(() => {
  function createDashboardLoaders(deps) {
    const {
      state,
      currentView,
      viewDataCache,
      getFreshCacheEntry,
      setTimedCacheEntry,
      MAX_VIEW_CACHE_ENTRIES,
      VIEW_CACHE_TTL_MS,
      chainCacheKey,
      contractsListParams,
      tokensListParams,
      toQueryString,
      tokenCacheKey,
      contractCacheKey,
      getTablePageSize,
      currentContractsCacheKey,
      currentTokensCacheKey,
      assignDashboardContractsPayload,
      assignDashboardTokensPayload,
      assignTokenDetailPayload,
      assignContractDetailPayload,
      prepareDashboardContractRows,
      prepareDashboardTokenRows,
      prepareTokenDetail,
      prepareContractDetail,
      normalizeAiProvider,
      normalizeAiModel,
      hydrateTokenReviewForm,
      hydrateReviewForm,
      applySettingsPayload,
      apiFetch,
      withPageLoading,
      runSharedLoad,
    } = deps;

    async function loadDashboard(options = {}) {
      if (!state.selectedChain) return;
      try {
        const data = options.showLoading === false
          ? await apiFetch(`/api/dashboard?chain=${encodeURIComponent(state.selectedChain)}`)
          : await withPageLoading(
            'Loading dashboard',
            () => apiFetch(`/api/dashboard?chain=${encodeURIComponent(state.selectedChain)}`),
          );
        state.dashboard.run = data.run || null;
        state.dashboard.tokens = data.tokens || [];
        state.dashboard.contracts = data.contracts || [];
        if (state.dashboardTab === 'settings' || state.dashboardTab === 'auto') {
          await loadSettings({ showLoading: false });
        }
      } catch {
        state.dashboard.run = null;
        state.dashboard.tokens = [];
        state.dashboard.contracts = [];
      }
    }

    async function loadDashboardContracts(options = {}) {
      if (!state.selectedChain) return;
      const requestChain = chainCacheKey(state.selectedChain);
      const queryParams = contractsListParams(requestChain);
      const queryString = toQueryString(queryParams);
      const cacheKey = `${requestChain}?${queryString}`;
      if (options.force !== true) {
        const cached = getFreshCacheEntry(viewDataCache.dashboardContracts, cacheKey, VIEW_CACHE_TTL_MS.dashboardContracts);
        if (cached) {
          assignDashboardContractsPayload(cached);
          state.listMeta.contractOverview = {
            totalRows: Number(cached.totalRows || 0),
            pageSize: Number(cached.pageSize || getTablePageSize('contractOverview')),
          };
          return;
        }
      }
      await runSharedLoad(`dashboard-contracts:${cacheKey}`, async () => {
        try {
          const data = options.showLoading === false
            ? await apiFetch(`/api/contracts?${queryString}`)
            : await withPageLoading(
              'Loading contracts',
              () => apiFetch(`/api/contracts?${queryString}`),
            );
          const payload = {
            run: data.run || null,
            contracts: data.contracts || [],
            preparedContracts: prepareDashboardContractRows(data.contracts || []),
            totalRows: Number(data.total_rows || 0),
            pageSize: Number(data.page_size || getTablePageSize('contractOverview')),
          };
          setTimedCacheEntry(
            viewDataCache.dashboardContracts,
            cacheKey,
            payload,
            MAX_VIEW_CACHE_ENTRIES.dashboardContracts,
          );
          if (currentContractsCacheKey() !== cacheKey) return;
          state.listMeta.contractOverview = {
            totalRows: payload.totalRows,
            pageSize: payload.pageSize,
          };
          assignDashboardContractsPayload(payload);
        } catch {
          if (chainCacheKey(state.selectedChain) !== requestChain) return;
          state.listMeta.contractOverview = {
            totalRows: 0,
            pageSize: getTablePageSize('contractOverview'),
          };
          assignDashboardContractsPayload({ run: null, contracts: [], preparedContracts: [] });
        }
      });
    }

    async function loadDashboardTokens(options = {}) {
      if (!state.selectedChain) return;
      const requestChain = chainCacheKey(state.selectedChain);
      const queryParams = tokensListParams(requestChain);
      const queryString = toQueryString(queryParams);
      const cacheKey = `${requestChain}?${queryString}`;
      if (options.force !== true) {
        const cached = getFreshCacheEntry(viewDataCache.dashboardTokens, cacheKey, VIEW_CACHE_TTL_MS.dashboardTokens);
        if (cached) {
          assignDashboardTokensPayload(cached);
          state.listMeta.tokenDirectory = {
            totalRows: Number(cached.totalRows || 0),
            pageSize: Number(cached.pageSize || getTablePageSize('tokenDirectory')),
          };
          return;
        }
      }
      await runSharedLoad(`dashboard-tokens:${cacheKey}`, async () => {
        try {
          const data = options.showLoading === false
            ? await apiFetch(`/api/tokens?${queryString}`)
            : await withPageLoading(
              'Loading tokens',
              () => apiFetch(`/api/tokens?${queryString}`),
            );
          const payload = {
            run: data.run || null,
            tokens: data.tokens || [],
            preparedTokens: prepareDashboardTokenRows(data.tokens || []),
            totalRows: Number(data.total_rows || 0),
            pageSize: Number(data.page_size || getTablePageSize('tokenDirectory')),
          };
          setTimedCacheEntry(
            viewDataCache.dashboardTokens,
            cacheKey,
            payload,
            MAX_VIEW_CACHE_ENTRIES.dashboardTokens,
          );
          if (currentTokensCacheKey() !== cacheKey) return;
          state.listMeta.tokenDirectory = {
            totalRows: payload.totalRows,
            pageSize: payload.pageSize,
          };
          assignDashboardTokensPayload(payload);
        } catch {
          if (chainCacheKey(state.selectedChain) !== requestChain) return;
          state.listMeta.tokenDirectory = {
            totalRows: 0,
            pageSize: getTablePageSize('tokenDirectory'),
          };
          assignDashboardTokensPayload({ run: null, tokens: [], preparedTokens: [] });
        }
      });
    }

    async function loadTokenDetail(options = {}) {
      if (!state.selectedChain || !state.route.token) return;
      const requestChain = chainCacheKey(state.selectedChain);
      const requestToken = String(state.route.token || '').toLowerCase();
      const cacheKey = tokenCacheKey(requestChain, requestToken);
      if (options.force !== true) {
        const cached = getFreshCacheEntry(viewDataCache.tokenDetail, cacheKey, VIEW_CACHE_TTL_MS.tokenDetail);
        if (cached) {
          assignTokenDetailPayload(cached);
          state.aiConfig.providers = cached.aiProviders || [];
          state.aiConfig.models = cached.aiModels || [];
          state.aiConfig.default_provider = cached.defaultProvider || state.aiConfig.default_provider;
          state.aiConfig.default_model = cached.defaultModel || state.aiConfig.default_model;
          state.analysisForm.title = state.tokenDetail?.auto_analysis?.title || 'AI Auto Audit';
          state.analysisForm.provider = normalizeAiProvider(state.tokenDetail?.auto_analysis?.provider);
          state.analysisForm.model = normalizeAiModel(state.analysisForm.provider, state.tokenDetail?.auto_analysis?.model);
          hydrateTokenReviewForm();
          return;
        }
      }
      await runSharedLoad(`token-detail:${cacheKey}`, async () => {
        try {
          const data = options.showLoading === false
            ? await apiFetch(`/api/token?chain=${encodeURIComponent(requestChain)}&token=${encodeURIComponent(requestToken)}`)
            : await withPageLoading(
              'Loading token details',
              () => apiFetch(`/api/token?chain=${encodeURIComponent(requestChain)}&token=${encodeURIComponent(requestToken)}`),
            );
          const payload = {
            token: data.token || null,
            preparedTokenDetail: prepareTokenDetail(data.token || null),
            aiProviders: data.ai_config?.ai_providers || [],
            aiModels: data.ai_config?.ai_models || [],
            defaultProvider: data.ai_config?.default_provider || state.aiConfig.default_provider,
            defaultModel: data.ai_config?.default_model || state.aiConfig.default_model,
          };
          setTimedCacheEntry(
            viewDataCache.tokenDetail,
            cacheKey,
            payload,
            MAX_VIEW_CACHE_ENTRIES.tokenDetail,
          );
          if (tokenCacheKey(state.selectedChain, state.route.token) !== cacheKey) return;
          assignTokenDetailPayload(payload);
          state.aiConfig.providers = payload.aiProviders;
          state.aiConfig.models = payload.aiModels;
          state.aiConfig.default_provider = payload.defaultProvider;
          state.aiConfig.default_model = payload.defaultModel;
          state.analysisForm.title = state.tokenDetail?.auto_analysis?.title || 'AI Auto Audit';
          state.analysisForm.provider = normalizeAiProvider(state.tokenDetail?.auto_analysis?.provider);
          state.analysisForm.model = normalizeAiModel(state.analysisForm.provider, state.tokenDetail?.auto_analysis?.model);
          hydrateTokenReviewForm();
        } catch {
          if (tokenCacheKey(state.selectedChain, state.route.token) !== cacheKey) return;
          assignTokenDetailPayload({ token: null, preparedTokenDetail: prepareTokenDetail(null) });
        }
      });
    }

    async function loadContractDetail(options = {}) {
      if (!state.selectedChain || !state.route.contract) return;
      const requestChain = chainCacheKey(state.selectedChain);
      const requestContract = String(state.route.contract || '').toLowerCase();
      const cacheKey = contractCacheKey(requestChain, requestContract);
      if (options.force !== true) {
        const cached = getFreshCacheEntry(viewDataCache.contractDetail, cacheKey, VIEW_CACHE_TTL_MS.contractDetail);
        if (cached) {
          assignContractDetailPayload(cached);
          state.aiConfig.providers = cached.aiProviders || [];
          state.aiConfig.models = cached.aiModels || [];
          state.aiConfig.default_provider = cached.defaultProvider || state.aiConfig.default_provider;
          state.aiConfig.default_model = cached.defaultModel || state.aiConfig.default_model;
          const availableTokens = state.contractDetail?.tokens || [];
          const selected = state.selectedContractFlowToken?.toLowerCase();
          if (!availableTokens.length) {
            state.selectedContractFlowToken = '';
          } else if (!selected || !availableTokens.some((row) => row.token?.token?.toLowerCase() === selected)) {
            state.selectedContractFlowToken = availableTokens[0]?.token?.token || '';
          }
          hydrateReviewForm();
          return;
        }
      }
      await runSharedLoad(`contract-detail:${cacheKey}`, async () => {
        try {
          const data = options.showLoading === false
            ? await apiFetch(`/api/contract?chain=${encodeURIComponent(requestChain)}&contract=${encodeURIComponent(requestContract)}`)
            : await withPageLoading(
              'Loading contract details',
              () => apiFetch(`/api/contract?chain=${encodeURIComponent(requestChain)}&contract=${encodeURIComponent(requestContract)}`),
            );
          const payload = {
            contract: data.contract || null,
            preparedContractDetail: prepareContractDetail(data.contract || null),
            aiProviders: data.ai_config?.ai_providers || [],
            aiModels: data.ai_config?.ai_models || [],
            defaultProvider: data.ai_config?.default_provider || state.aiConfig.default_provider,
            defaultModel: data.ai_config?.default_model || state.aiConfig.default_model,
          };
          setTimedCacheEntry(
            viewDataCache.contractDetail,
            cacheKey,
            payload,
            MAX_VIEW_CACHE_ENTRIES.contractDetail,
          );
          if (contractCacheKey(state.selectedChain, state.route.contract) !== cacheKey) return;
          assignContractDetailPayload(payload);
          state.aiConfig.providers = payload.aiProviders;
          state.aiConfig.models = payload.aiModels;
          state.aiConfig.default_provider = payload.defaultProvider;
          state.aiConfig.default_model = payload.defaultModel;
          const availableTokens = state.contractDetail?.tokens || [];
          const selected = state.selectedContractFlowToken?.toLowerCase();
          if (!availableTokens.length) {
            state.selectedContractFlowToken = '';
          } else if (!selected || !availableTokens.some((row) => row.token?.token?.toLowerCase() === selected)) {
            state.selectedContractFlowToken = availableTokens[0]?.token?.token || '';
          }
          hydrateReviewForm();
        } catch {
          if (contractCacheKey(state.selectedChain, state.route.contract) !== cacheKey) return;
          assignContractDetailPayload({ contract: null, preparedContractDetail: prepareContractDetail(null) });
          state.selectedContractFlowToken = '';
        }
      });
    }

    async function loadSettings(options = {}) {
      if (options.force !== true && viewDataCache.settings) {
        const entry = viewDataCache.settings;
        const freshEnough = Number.isFinite(entry?.cachedAt)
          && (Date.now() - entry.cachedAt) <= VIEW_CACHE_TTL_MS.settings;
        const data = freshEnough ? entry.payload : null;
        if (!freshEnough) viewDataCache.settings = null;
        if (data) {
          applySettingsPayload(data);
          return;
        }
      }
      await runSharedLoad('settings', async () => {
        const data = options.showLoading === false
          ? await apiFetch('/api/settings')
          : await withPageLoading('Loading settings', () => apiFetch('/api/settings'));
        viewDataCache.settings = {
          payload: data,
          cachedAt: Date.now(),
        };
        applySettingsPayload(data);
      });
    }

    async function refreshCurrent(options = {}) {
      const nextOptions = { force: true, ...options };
      if (currentView.value === 'dashboard') {
        if (state.dashboardTab === 'settings' || state.dashboardTab === 'auto') {
          await loadSettings(nextOptions);
          return;
        }
        await loadDashboardContracts(nextOptions);
      } else if (currentView.value === 'token') {
        await loadDashboardTokens(nextOptions);
      } else if (currentView.value === 'token-detail') {
        await loadTokenDetail(nextOptions);
      } else {
        await loadContractDetail(nextOptions);
      }
    }

    async function loadViewDataForCurrentRoute(options = {}) {
      if (currentView.value === 'dashboard') {
        if (state.dashboardTab === 'settings' || state.dashboardTab === 'auto') {
          await loadSettings(options);
          return;
        }
        await loadDashboardContracts(options);
        return;
      }
      if (currentView.value === 'token') {
        await loadDashboardTokens(options);
        return;
      }
      if (currentView.value === 'token-detail') {
        await loadTokenDetail(options);
        return;
      }
      await loadContractDetail(options);
    }

    function clearChainScopedData() {
      state.dashboard.run = null;
      state.dashboard.tokens = [];
      state.dashboard.contracts = [];
      state.listMeta.contractOverview = { totalRows: 0, pageSize: getTablePageSize('contractOverview') };
      state.listMeta.tokenDirectory = { totalRows: 0, pageSize: getTablePageSize('tokenDirectory') };
      state.prepared.dashboardTokens = [];
      state.prepared.dashboardContracts = [];
      state.tokenDetail = null;
      state.contractDetail = null;
      state.prepared.tokenDetail = prepareTokenDetail(null);
      state.prepared.contractDetail = prepareContractDetail(null);
      state.selectedContractFlowToken = '';
    }

    return {
      loadDashboard,
      loadDashboardContracts,
      loadDashboardTokens,
      loadTokenDetail,
      loadContractDetail,
      loadSettings,
      refreshCurrent,
      loadViewDataForCurrentRoute,
      clearChainScopedData,
    };
  }

  window.EventFilterDashboardLoaders = {
    createDashboardLoaders,
  };
})();
