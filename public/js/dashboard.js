(() => {
  const vueApi = window.Vue;
  const routerApi = window.VueRouter;
  const piniaApi = window.Pinia;
  const appRoot = document.getElementById('app');

  if (!vueApi || !routerApi || !piniaApi) {
    if (appRoot) {
      appRoot.removeAttribute('v-cloak');
      appRoot.innerHTML = `
        <section class="card app-error-card">
          <div class="card-head">
            <h2>Frontend Load Failed</h2>
            <span class="muted">Frontend runtime missing</span>
          </div>
          <p class="muted">
            The dashboard could not load its local Vue, Router, or Pinia runtime. Check static asset delivery and refresh the page.
          </p>
        </section>
      `;
    }
    return;
  }

  const { createApp, reactive, computed, onMounted, watch, nextTick, markRaw } = vueApi;
  const { createRouter, createWebHistory } = routerApi;
  const { createPinia, defineStore } = piniaApi;
  const PREV_ROUTE_STORAGE_KEY = 'event-filter-prev-route';
  const PREV_ROUTE_SCROLL_STORAGE_KEY = 'event-filter-prev-route-scroll';
  const AUTH_ENABLED = document.body.dataset.authEnabled === '1';
  const CURRENT_USER = document.body.dataset.currentUser || '';
  const shared = window.EventFilterDashboardShared || {};
  const runtime = window.EventFilterDashboardRuntime || {};
  const scrollSyncRuntime = window.EventFilterDashboardScrollSync || {};
  const loaderRuntime = window.EventFilterDashboardLoaders || {};
  const actionRuntime = window.EventFilterDashboardActions || {};
  const modalRuntime = window.EventFilterDashboardModals || {};
  const routingRuntime = window.EventFilterDashboardRouting || {};
  const tableStateRuntime = window.EventFilterDashboardTableState || {};
  const viewStateRuntime = window.EventFilterDashboardViewState || {};
  const {
    toBigIntSafe,
    compareString,
    compareNumber,
    compareBoolean,
    compareBigInt,
    compareDate,
    formatUsd,
    formatBig,
    formatTokenAmount,
    parseStoredUtcDate,
    formatDateTime,
    formatRelativeTime,
    shortAddress,
    writeClipboardText,
    syncStateLabel,
    syncStateTone,
    autoAuditStatusTone,
    autoAuditStatusLabel,
    autoAuditSeveritySummary,
    auditResultDisplay,
    contractToneClass,
    tokenToneClass,
    buildPatternSections,
    prepareDashboardTokenRows,
    prepareDashboardContractRows,
    prepareTokenDetail,
    prepareContractDetail,
  } = shared;
  const {
    setBoundedMapEntry,
    setTimedCacheEntry,
    getFreshCacheEntry,
    createToastController,
  } = runtime;
  const { createDashboardScrollSync } = scrollSyncRuntime;
  const { createDashboardLoaders } = loaderRuntime;
  const { createDashboardActions } = actionRuntime;
  const { createDashboardModals } = modalRuntime;
  const { createDashboardRouting } = routingRuntime;
  const { createDashboardTableState } = tableStateRuntime;
  const { installDashboardViewState } = viewStateRuntime;

  async function apiFetch(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data?.auth_required) {
      const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return await new Promise(() => {});
    }
    if (!res.ok) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data;
  }

  const initialView = (document.body.dataset.initialView || 'dashboard').toLowerCase();
  const query = new URLSearchParams(window.location.search);
  const SORT_STORAGE_KEY = 'event-filter-dashboard.table-sorts.v1';
  const SCROLL_STORAGE_KEY = 'event-filter-dashboard.scroll.v1';
  const FILTER_STORAGE_KEY = 'event-filter-dashboard.filters.v1';
  const GROUP_COLLAPSE_STORAGE_KEY = 'event-filter-dashboard.group-collapse.v1';
  const PAGE_SIZE_STORAGE_KEY = 'event-filter-dashboard.page-sizes.v1';
  const TABLE_PAGE_SIZE = {
    contractOverview: 40,
    tokenDirectory: 40,
    tokenRelatedContracts: 30,
  };
  const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
  const MAX_VIEW_CACHE_ENTRIES = {
    dashboardContracts: 48,
    dashboardTokens: 48,
    tokenDetail: 32,
    contractDetail: 48,
    recentRunRefreshes: 16,
  };
  const VIEW_CACHE_TTL_MS = {
    dashboardContracts: 20_000,
    dashboardTokens: 20_000,
    tokenDetail: 45_000,
    contractDetail: 45_000,
    settings: 30_000,
  };
  const DEFAULT_AI_PROVIDER_MODELS = {
    claude: ['claude-sonnet', 'claude-opus'],
    codex: ['gpt-5-codex', 'gpt-5-codex-mini'],
  };
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'dashboard' },
      { path: '/token', name: 'token' },
      { path: '/token-detail', name: 'token-detail' },
      { path: '/contract', name: 'contract' },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
  });
  const pinia = createPinia();

  function queryOrDefault(key, fallback, allowedValues) {
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

  function readStoredFilters() {
    return readJsonStorage(window.localStorage, FILTER_STORAGE_KEY, {});
  }

  function persistStoredFilters(filters) {
    writeJsonStorage(window.localStorage, FILTER_STORAGE_KEY, filters);
  }

  function readStoredCollapsedGroups() {
    return readJsonStorage(window.localStorage, GROUP_COLLAPSE_STORAGE_KEY, {});
  }

  function persistStoredCollapsedGroups(groups) {
    writeJsonStorage(window.localStorage, GROUP_COLLAPSE_STORAGE_KEY, groups);
  }

  function readStoredPageSizes() {
    return readJsonStorage(window.localStorage, PAGE_SIZE_STORAGE_KEY, {});
  }

  function persistStoredPageSizes(pageSizes) {
    writeJsonStorage(window.localStorage, PAGE_SIZE_STORAGE_KEY, pageSizes);
  }

  function countSettingLines(value) {
    if (Array.isArray(value)) return value.filter(Boolean).length;
    return String(value || '')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .length;
  }

  const useDashboardStore = defineStore('eventFilterDashboard', () => {
    const storedFilters = readStoredFilters();
    const storedCollapsedGroups = readStoredCollapsedGroups();
    const storedPageSizes = readStoredPageSizes();
    const state = reactive({
      chains: [],
      selectedChain: (query.get('chain') || '').toLowerCase(),
      latestRuns: [],
      running: false,
      runningChain: null,
      progress: null,
      dashboardTab: queryOrDefault('tab', 'tokens', ['tokens', 'auto', 'settings']),
      settingsSection: queryOrDefault('st', 'keys', ['keys', 'runtime', 'access', 'pattern-sync', 'chains', 'whitelist', 'ai']),
      dashboard: {
        run: null,
        tokens: [],
        contracts: [],
      },
      listMeta: {
        contractOverview: { totalRows: 0, pageSize: TABLE_PAGE_SIZE.contractOverview },
        tokenDirectory: { totalRows: 0, pageSize: TABLE_PAGE_SIZE.tokenDirectory },
      },
      prepared: {
        dashboardTokens: [],
        dashboardContracts: [],
        tokenDetail: {
          contractsFlat: [],
          groupCards: [],
          exploitableCount: 0,
          largestBalance: '0',
        },
        contractDetail: {
          flowTokenOptions: [],
        },
      },
      dashboardFilters: {
        tokenQuery: String(storedFilters.tokenQuery ?? query.get('tq') ?? ''),
        contractQuery: String(storedFilters.contractQuery ?? query.get('cq') ?? ''),
        contractRisk: routeValueOrDefault(
          String(storedFilters.contractRisk ?? query.get('cr') ?? ''),
          'all',
          ['all', 'exploitable', 'seen', 'unseen'],
        ),
        contractLinkType: routeValueOrDefault(
          String(storedFilters.contractLinkType ?? query.get('cl') ?? ''),
          'all',
          ['all', 'plain', 'proxy', 'eip7702'],
        ),
        tokenRelatedSeen: routeValueOrDefault(
          String(storedFilters.tokenRelatedSeen ?? ''),
          'all',
          ['all', 'seen', 'unseen'],
        ),
      },
      collapsedGroups: {
        contractOverview: storedCollapsedGroups.contractOverview || {},
        tokenRelatedContracts: storedCollapsedGroups.tokenRelatedContracts || {},
      },
      tablePages: {
        contractOverview: 1,
        tokenDirectory: 1,
        tokenRelatedContracts: 1,
      },
      tablePageSizes: {
        contractOverview: Number(storedPageSizes.contractOverview) || TABLE_PAGE_SIZE.contractOverview,
        tokenDirectory: Number(storedPageSizes.tokenDirectory) || TABLE_PAGE_SIZE.tokenDirectory,
        tokenRelatedContracts: Number(storedPageSizes.tokenRelatedContracts) || TABLE_PAGE_SIZE.tokenRelatedContracts,
      },
      tableSorts: {
        contractOverview: { key: 'total_usd', dir: 'desc' },
        tokenDirectory: { key: 'contracts', dir: 'desc' },
        chainConfig: { key: 'chain', dir: 'asc' },
        tokenRelatedContracts: { key: 'balance', dir: 'desc' },
        contractTokens: { key: 'balance', dir: 'desc' },
        contractTokenFlows: { key: 'total_flow', dir: 'desc' },
        reviewHistory: { key: 'updated', dir: 'desc' },
      },
      tokenDetail: null,
      contractDetail: null,
      settings: {
        runtime_settings: {
          chainbase_keys: '',
          rpc_keys: '',
          monitored_chains: [],
          poll_interval_ms: 600000,
          debug: false,
          pattern_sync: {
            host: '',
            port: 5432,
            database: '',
            user: '',
            password: '',
            remote_name: 'default',
            auto_pull: true,
            ssl: false,
          },
          pancakeswap_price: {
            max_req_per_second: 2,
            max_req_per_minute: 90,
          },
          ai_audit_backend: {
            base_url: 'https://127.0.0.1:5000',
            api_key: '',
            etherscan_api_key: '',
            poll_interval_ms: 10000,
            dedaub_wait_seconds: 15,
            insecure_tls: true,
          },
          auto_analysis: {
            queue_capacity: 10,
            token_share_percent: 40,
            contract_share_percent: 60,
            provider: 'claude',
            model: DEFAULT_AI_PROVIDER_MODELS.claude[0],
            contract_min_tvl_usd: 10000,
            token_min_price_usd: 0.001,
            require_token_sync: true,
            require_contract_selectors: true,
            skip_seen_contracts: true,
            one_per_contract_pattern: true,
            exclude_audited_contracts: true,
            exclude_audited_tokens: true,
          },
          access: {
            auth_enabled: false,
            username: '',
            password: '',
            has_password: false,
            https_enabled: false,
            tls_cert_path: '',
            tls_key_path: '',
          },
        },
        chain_configs: [],
        ai_providers: [],
        ai_models: [],
        whitelist_patterns: [],
      },
      aiConfig: {
        providers: [],
        models: [],
        default_provider: 'claude',
        default_model: DEFAULT_AI_PROVIDER_MODELS.claude[0],
      },
      syncStatus: null,
      autoAnalysis: {
        enabled: false,
        stopping: false,
        chain: null,
        phase: 'idle',
        queued: 0,
        active: 0,
        capacity: 10,
        cycle: 0,
        lastAction: 'Auto analysis is idle',
        updatedAt: null,
      },
      route: {
        view: initialView,
        token: (query.get('token') || '').toLowerCase(),
        contract: (query.get('contract') || '').toLowerCase(),
      },
      reviewForm: {
        target_kind: 'contract',
        label: '',
        review_text: '',
        exploitable: false,
      },
      contractReviewModal: {
        open: false,
        address: '',
        target_kind: 'auto',
        target_options: [],
        label: '',
        review_text: '',
        exploitable: false,
        row: null,
        source: '',
        saving: false,
        error: '',
      },
      tokenReviewModal: {
        open: false,
        address: '',
        name: '',
        symbol: '',
        review_text: '',
        exploitable: false,
        saving: false,
        error: '',
      },
      tokenReviewForm: {
        review_text: '',
        exploitable: false,
      },
      tokenReviewExpanded: false,
      analysisForm: {
        title: 'AI Auto Audit',
        provider: 'claude',
        model: DEFAULT_AI_PROVIDER_MODELS.claude[0],
      },
      selectedContractFlowToken: '',
      copiedAddress: '',
      authEnabled: AUTH_ENABLED,
      currentUser: CURRENT_USER,
      pageLoading: {
        count: 0,
        label: '',
      },
      notifications: [],
    });
    return { state };
  });

  const app = createApp({
    setup() {
      const store = useDashboardStore();
      const state = store.state;
      const viewDataCache = {
        dashboardContracts: new Map(),
        dashboardTokens: new Map(),
        tokenDetail: new Map(),
        contractDetail: new Map(),
        settings: null,
      };
      const inFlightLoads = new Map();
      const recentRunRefreshes = new Map();
      const {
        dismissNotification,
        pushNotification,
      } = createToastController(state.notifications, {
        maxVisible: 4,
        defaultDurationMs: 3600,
      });

      function assignDashboardContractsPayload(payload) {
        state.dashboard.run = payload.run || null;
        state.dashboard.contracts = payload.contracts ? markRaw(payload.contracts) : [];
        state.prepared.dashboardContracts = payload.preparedContracts || prepareDashboardContractRows(payload.contracts || []);
      }

      function assignDashboardTokensPayload(payload) {
        state.dashboard.run = payload.run || null;
        state.dashboard.tokens = payload.tokens ? markRaw(payload.tokens) : [];
        state.prepared.dashboardTokens = payload.preparedTokens || prepareDashboardTokenRows(payload.tokens || []);
      }

      function assignTokenDetailPayload(payload) {
        state.tokenDetail = payload.token ? markRaw(payload.token) : null;
        state.prepared.tokenDetail = payload.preparedTokenDetail || prepareTokenDetail(payload.token);
      }

      function assignContractDetailPayload(payload) {
        state.contractDetail = payload.contract ? markRaw(payload.contract) : null;
        state.prepared.contractDetail = payload.preparedContractDetail || prepareContractDetail(payload.contract);
      }

      function applySettingsPayload(data) {
        if (!data) return;
        state.settings.runtime_settings = {
          ...state.settings.runtime_settings,
          ...(data.runtime_settings || {}),
          chainbase_keys: Array.isArray(data.runtime_settings?.chainbase_keys)
            ? data.runtime_settings.chainbase_keys.join('\n')
            : String(data.runtime_settings?.chainbase_keys || ''),
          rpc_keys: Array.isArray(data.runtime_settings?.rpc_keys)
            ? data.runtime_settings.rpc_keys.join('\n')
            : String(data.runtime_settings?.rpc_keys || ''),
        };
        state.settings.runtime_settings.auto_analysis.provider = normalizeAiProvider(state.settings.runtime_settings.auto_analysis.provider);
        state.settings.runtime_settings.auto_analysis.model = normalizeAiModel(
          state.settings.runtime_settings.auto_analysis.provider,
          state.settings.runtime_settings.auto_analysis.model,
        );
        state.settings.chain_configs = data.chain_configs || [];
        state.settings.ai_providers = data.ai_providers || [];
        state.settings.ai_models = data.ai_models || [];
        state.settings.whitelist_patterns = data.whitelist_patterns || [];
        state.aiConfig.providers = data.ai_providers || [];
        state.aiConfig.models = data.ai_models || [];
        state.aiConfig.default_provider = data.ai_providers?.find?.((row) => row.isDefault)?.provider || state.aiConfig.default_provider;
        state.analysisForm.provider = normalizeAiProvider(state.analysisForm.provider);
        state.analysisForm.model = normalizeAiModel(state.analysisForm.provider, state.analysisForm.model);
        if (state.contractDetail) hydrateReviewForm();
      }

      function runSharedLoad(key, task) {
        const existing = inFlightLoads.get(key);
        if (existing) return existing;
        const promise = Promise.resolve()
          .then(task)
          .finally(() => {
            if (inFlightLoads.get(key) === promise) {
              inFlightLoads.delete(key);
            }
          });
        inFlightLoads.set(key, promise);
        return promise;
      }

      function rememberRunRefresh(chain, refreshKey) {
        const normalizedChain = chainCacheKey(chain);
        const normalizedKey = String(refreshKey || '').trim();
        if (!normalizedChain || !normalizedKey) return;
        setBoundedMapEntry(
          recentRunRefreshes,
          normalizedChain,
          normalizedKey,
          MAX_VIEW_CACHE_ENTRIES.recentRunRefreshes,
        );
      }

      function hasRecentRunRefresh(chain, refreshKey) {
        const normalizedChain = chainCacheKey(chain);
        const normalizedKey = String(refreshKey || '').trim();
        if (!normalizedChain || !normalizedKey) return false;
        return recentRunRefreshes.get(normalizedChain) === normalizedKey;
      }

      let hydrateReviewForm = () => {};
      let hydrateTokenReviewForm = () => {};
      let copiedAddressTimer = null;
      let collectionReloadTimer = null;
      const storedSorts = readJsonStorage(window.localStorage, SORT_STORAGE_KEY, {});
      Object.entries(storedSorts || {}).forEach(([tableId, sortState]) => {
        if (!sortState || typeof sortState !== 'object') return;
        if (!state.tableSorts[tableId]) return;
        const key = typeof sortState.key === 'string' ? sortState.key : state.tableSorts[tableId].key;
        const dir = sortState.dir === 'asc' ? 'asc' : 'desc';
        state.tableSorts[tableId] = { key, dir };
      });

      function chainCacheKey(chain) {
        return String(chain || '').toLowerCase();
      }

      function contractsListParams(chain = state.selectedChain) {
        const sort = getTableSort('contractOverview');
        return {
          chain: chainCacheKey(chain),
          q: state.dashboardFilters.contractQuery || '',
          risk: state.dashboardFilters.contractRisk || 'all',
          link: state.dashboardFilters.contractLinkType || 'all',
          sort_key: sort.key || 'total_usd',
          sort_dir: sort.dir || 'desc',
          page: String(getTablePage('contractOverview')),
          page_size: String(getTablePageSize('contractOverview')),
        };
      }

      function tokensListParams(chain = state.selectedChain) {
        const sort = getTableSort('tokenDirectory');
        return {
          chain: chainCacheKey(chain),
          q: state.dashboardFilters.tokenQuery || '',
          sort_key: sort.key || 'contracts',
          sort_dir: sort.dir || 'desc',
          page: String(getTablePage('tokenDirectory')),
          page_size: String(getTablePageSize('tokenDirectory')),
        };
      }

      function toQueryString(params) {
        const search = new URLSearchParams();
        Object.entries(params || {}).forEach(([key, value]) => {
          if (value == null || value === '') return;
          search.set(key, String(value));
        });
        return search.toString();
      }

      function tokenCacheKey(chain, token) {
        return `${chainCacheKey(chain)}:${String(token || '').toLowerCase()}`;
      }

      function contractCacheKey(chain, contract) {
        return `${chainCacheKey(chain)}:${String(contract || '').toLowerCase()}`;
      }

      function invalidateChainCache(chain) {
        const normalizedChain = chainCacheKey(chain);
        invalidateChainCollectionCache(normalizedChain);
        for (const key of [...viewDataCache.tokenDetail.keys()]) {
          if (key.startsWith(`${normalizedChain}:`)) viewDataCache.tokenDetail.delete(key);
        }
        for (const key of [...viewDataCache.contractDetail.keys()]) {
          if (key.startsWith(`${normalizedChain}:`)) viewDataCache.contractDetail.delete(key);
        }
      }

      function invalidateChainCollectionCache(chain) {
        const normalizedChain = chainCacheKey(chain);
        viewDataCache.dashboardContracts.delete(normalizedChain);
        viewDataCache.dashboardTokens.delete(normalizedChain);
        for (const key of [...viewDataCache.dashboardContracts.keys()]) {
          if (String(key).startsWith(`${normalizedChain}?`)) viewDataCache.dashboardContracts.delete(key);
        }
        for (const key of [...viewDataCache.dashboardTokens.keys()]) {
          if (String(key).startsWith(`${normalizedChain}?`)) viewDataCache.dashboardTokens.delete(key);
        }
      }

      function currentContractsCacheKey() {
        const requestChain = chainCacheKey(state.selectedChain);
        return `${requestChain}?${toQueryString(contractsListParams(requestChain))}`;
      }

      function currentTokensCacheKey() {
        const requestChain = chainCacheKey(state.selectedChain);
        return `${requestChain}?${toQueryString(tokensListParams(requestChain))}`;
      }

      function scheduleCollectionReload(kind) {
        if (collectionReloadTimer) {
          window.clearTimeout(collectionReloadTimer);
        }
        collectionReloadTimer = window.setTimeout(() => {
          collectionReloadTimer = null;
          if (kind === 'contracts' && currentView.value === 'dashboard' && state.dashboardTab === 'tokens') {
            void loadDashboardContracts({ showLoading: false });
          } else if (kind === 'tokens' && currentView.value === 'token') {
            void loadDashboardTokens({ showLoading: false });
          }
        }, 220);
      }

      function syncStateFromRoute() {
        const route = router.currentRoute.value;
        const routeQuery = route.query || {};
        state.route.view = String(route.name || initialView).toLowerCase();
        state.route.token = String(routeQuery.token || '').toLowerCase();
        state.route.contract = String(routeQuery.contract || '').toLowerCase();
        state.dashboardTab = routeValueOrDefault(
          String(routeQuery.tab || ''),
          'tokens',
          ['tokens', 'auto', 'settings'],
        );
        state.settingsSection = routeValueOrDefault(
          String(routeQuery.st || ''),
          'keys',
          ['keys', 'runtime', 'access', 'pattern-sync', 'chains', 'whitelist', 'ai'],
        );
        const nextChain = String(routeQuery.chain || '').toLowerCase();
        if (nextChain) state.selectedChain = nextChain;
      }

      syncStateFromRoute();

      const currentView = computed(() => {
        if (state.route.view === 'token') return 'token';
        if (state.route.view === 'token-detail') return 'token-detail';
        if (state.route.view === 'contract') return 'contract';
        return 'dashboard';
      });

      const tableState = createDashboardTableState({
        state,
        currentView,
        TABLE_PAGE_SIZE,
        PAGE_SIZE_OPTIONS,
        sortStorageKey: SORT_STORAGE_KEY,
        persistStoredPageSizes,
        writeJsonStorage,
        scheduleCollectionReload,
        getTokenRelatedContractCount: () => sortedTokenContracts.value.length,
      });

      const {
        getTableSort,
        getTablePage,
        toggleTableSort,
        sortIndicator,
        isActiveSort,
        getTablePageSize,
        paginateRows,
        resetTablePage,
        setTablePageSize,
        getTablePaginationMeta,
        canMoveTablePage,
        moveTablePage,
        goToTablePage,
        getTablePageButtons,
      } = tableState;

      const scrollSync = createDashboardScrollSync({
        router,
        nextTick,
        state,
        currentView,
        compareString,
        readJsonStorage,
        writeJsonStorage,
        previousRouteStorageKey: PREV_ROUTE_STORAGE_KEY,
        previousRouteScrollStorageKey: PREV_ROUTE_SCROLL_STORAGE_KEY,
        scrollStorageKey: SCROLL_STORAGE_KEY,
      });

      const {
        currentRelativeRoute,
        rememberCurrentRouteContext,
        persistCurrentScroll,
        persistScrollForRoute,
        restoreCurrentScroll,
        restoreScrollPosition,
        dashboardUrlParams,
        updateUrl,
        syncDashboardUrlState,
        syncTokenUrlState,
        consumePendingRestoreState,
        goBackToPrevious,
      } = scrollSync;

      function getConfiguredAiProviders() {
        const sourceProviders = (state.aiConfig.providers?.length ? state.aiConfig.providers : state.settings.ai_providers) || [];
        const configured = sourceProviders
          .filter((row) => row && row.enabled !== false && String(row.provider || '').trim())
          .slice()
          .sort((a, b) => compareNumber(a.position, b.position) || compareString(a.provider, b.provider))
          .map((row) => String(row.provider).trim().toLowerCase());
        return configured.length ? configured : Object.keys(DEFAULT_AI_PROVIDER_MODELS);
      }

      function getConfiguredAiModels(provider) {
        const normalizedProvider = String(provider || '').trim().toLowerCase();
        const sourceModels = (state.aiConfig.models?.length ? state.aiConfig.models : state.settings.ai_models) || [];
        const configured = sourceModels
          .filter((row) => row && row.enabled !== false && String(row.provider || '').trim().toLowerCase() === normalizedProvider)
          .slice()
          .sort((a, b) => {
            if (Boolean(a.is_default) !== Boolean(b.is_default)) return a.is_default ? -1 : 1;
            return compareNumber(a.position, b.position) || compareString(a.model, b.model);
          })
          .map((row) => String(row.model || '').trim())
          .filter(Boolean);
        return configured.length ? configured : (DEFAULT_AI_PROVIDER_MODELS[normalizedProvider] || []);
      }

      function normalizeAiProvider(value) {
        const normalized = String(value || '').trim().toLowerCase();
        const allowed = getConfiguredAiProviders();
        return allowed.includes(normalized) ? normalized : (allowed[0] || state.aiConfig.default_provider || 'claude');
      }

      function normalizeAiModel(provider, value) {
        const normalizedProvider = normalizeAiProvider(provider);
        const allowed = getConfiguredAiModels(normalizedProvider);
        const normalizedValue = String(value || '').trim();
        return allowed.includes(normalizedValue) ? normalizedValue : (allowed[0] || '');
      }

      const aiProviderOptions = computed(() => getConfiguredAiProviders());

      const aiModelOptions = computed(() => getConfiguredAiModels(state.analysisForm.provider));
      const autoAnalysisProviderOptions = computed(() => getConfiguredAiProviders());
      const autoAnalysisModelOptions = computed(() => getConfiguredAiModels(state.settings.runtime_settings.auto_analysis.provider));

      const runMetaText = computed(() => {
        const active = state.latestRuns.find((row) => row.chain === state.selectedChain);
        if (!active) return 'No run yet.';
        return `${active.chain.toUpperCase()} | blocks ${active.block_from} -> ${active.block_to} | ${formatDateTime(active.generated_at)}`;
      });

      const routeToken = computed(() => state.route.token);
      const routeContract = computed(() => state.route.contract);
      const autoAnalysisStatus = computed(() => state.autoAnalysis || {});
      const autoAnalysisEnabled = computed(() => Boolean(state.autoAnalysis?.enabled));
      const autoAnalysisButtonLabel = computed(() => (
        autoAnalysisEnabled.value ? 'Stop Auto Mode' : 'Auto Search & Analyze'
      ));
      const autoAnalysisChipTone = computed(() => {
        if (state.autoAnalysis?.stopping) return 'warn';
        if (state.autoAnalysis?.enabled) return 'ok';
        return 'plain';
      });
      const autoAnalysisMetaText = computed(() => {
        const source = state.autoAnalysis;
        if (!source?.enabled && !source?.stopping) return 'auto analysis off';
        const chain = String(source.chain || '').toUpperCase() || '--';
        const inflight = `${source.active || 0} active / ${source.queued || 0} queued`;
        return `${chain} | ${source.phase || 'idle'} | ${inflight} | pool ${source.capacity || 10}`;
      });
      const autoAnalysisDetailText = computed(() => (
        String(state.autoAnalysis?.lastAction || '').trim() || 'Auto analysis is idle'
      ));
      const progressPercent = computed(() => {
        const value = Number(state.progress?.percent);
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.min(100, Math.round(value)));
      });
      const progressLabel = computed(() => state.progress?.label || 'Waiting for pipeline status');
      const progressStageLabel = computed(() => {
        const stage = String(state.progress?.stage || '').trim();
        if (!stage) return 'idle';
        return stage.replace(/-/g, ' ');
      });
      const progressDetailText = computed(() => {
        const progress = state.progress;
        if (!progress) return '';
        if (typeof progress.current === 'number' && typeof progress.total === 'number' && progress.total > 0) {
          return `${progress.current} / ${progress.total}`;
        }
        return progress.detail || '';
      });
      const progressStatusTone = computed(() => {
        if (state.progress?.stage === 'failed') return 'bad';
        if (state.running) return 'warn';
        if (state.progress?.stage === 'complete') return 'ok';
        return 'ok';
      });

      function persistCollapsedGroups() {
        persistStoredCollapsedGroups(state.collapsedGroups);
      }

      function sortRows(rows, tableId, compareFn) {
        const { dir } = getTableSort(tableId);
        const direction = dir === 'asc' ? 1 : -1;
        return [...rows].sort((a, b) => {
          const delta = compareFn(a, b);
          if (delta !== 0) return delta * direction;
          return 0;
        });
      }

      async function withPageLoading(label, task) {
        state.pageLoading.count += 1;
        state.pageLoading.label = label || 'Loading';
        try {
          return await task();
        } finally {
          state.pageLoading.count = Math.max(0, state.pageLoading.count - 1);
          if (state.pageLoading.count === 0) {
            state.pageLoading.label = '';
          }
        }
      }

      const filteredTokens = computed(() => {
        return state.prepared.dashboardTokens || [];
      });

      const paginatedFilteredTokens = computed(() => (
        filteredTokens.value
      ));

      const filteredContracts = computed(() => {
        return state.prepared.dashboardContracts || [];
      });

      const paginatedFilteredContracts = computed(() => (
        filteredContracts.value
      ));

      const contractOverviewSections = computed(() => (
        buildPatternSections(paginatedFilteredContracts.value).map((section) => ({
          ...section,
          collapsed: section.isGrouped && Boolean(state.collapsedGroups.contractOverview?.[section.key]),
        }))
      ));

      const tokenContracts = computed(() => {
        return state.prepared.tokenDetail.contractsFlat || [];
      });

      const filteredTokenContracts = computed(() => {
        const mode = String(state.dashboardFilters.tokenRelatedSeen || 'all');
        if (mode === 'all') return tokenContracts.value;
        return tokenContracts.value.filter((row) => {
          const isSeen = Boolean(row.is_seen_pattern || row.seen_label || row.group_kind === 'seen');
          return mode === 'seen' ? isSeen : !isSeen;
        });
      });

      const sortedTokenContracts = computed(() => (
        sortRows(filteredTokenContracts.value, 'tokenRelatedContracts', (a, b) => {
          const sort = getTableSort('tokenRelatedContracts');
          switch (sort.key) {
            case 'contract':
              return compareString(a.contract, b.contract);
            case 'group':
              return compareString(a.group_label || '', b.group_label || '');
            case 'label':
              return compareString(a.label || a.seen_label || '', b.label || b.seen_label || '');
            case 'patterns':
              return compareString((a.whitelist_patterns || []).join(','), (b.whitelist_patterns || []).join(','));
            case 'deployed':
              return compareDate(a.deployed_at || a.created_at, b.deployed_at || b.created_at);
            case 'flow':
              return compareBigInt(a.total_token_flow, b.total_token_flow);
            case 'auto_audit_status':
              return compareString(a.auto_audit_status || 'no', b.auto_audit_status || 'no');
            case 'audit_result':
              return compareString(auditResultDisplay(a), auditResultDisplay(b));
            case 'balance':
            default:
              return compareBigInt(a.current_balance, b.current_balance);
          }
        })
      ));

      const paginatedTokenContracts = computed(() => (
        paginateRows(sortedTokenContracts.value, 'tokenRelatedContracts')
      ));

      const tokenContractSections = computed(() => (
        buildPatternSections(paginatedTokenContracts.value).map((section) => ({
          ...section,
          collapsed: section.isGrouped && Boolean(state.collapsedGroups.tokenRelatedContracts?.[section.key]),
        }))
      ));

      function toggleGroupCollapse(tableId, sectionKey) {
        if (!tableId || !sectionKey) return;
        const bucket = state.collapsedGroups[tableId] || {};
        state.collapsedGroups[tableId] = {
          ...bucket,
          [sectionKey]: !bucket[sectionKey],
        };
        persistCollapsedGroups();
      }

      function isGroupCollapsed(tableId, sectionKey) {
        return Boolean(state.collapsedGroups?.[tableId]?.[sectionKey]);
      }

      const tokenGroupCards = computed(() => {
        return state.prepared.tokenDetail.groupCards || [];
      });

      const tokenExploitableCount = computed(() => (
        state.prepared.tokenDetail.exploitableCount || 0
      ));

      const tokenLargestBalance = computed(() => (
        state.prepared.tokenDetail.largestBalance || '0'
      ));

      const contractPatternTargets = computed(() => (
        state.contractDetail?.pattern_targets || []
      ));

      const contractReviewTargetOptions = computed(() => (
        state.contractReviewModal.target_options || []
      ));

      const contractReviewSelectedTarget = computed(() => (
        contractReviewTargetOptions.value.find((target) => target.kind === state.contractReviewModal.target_kind)
          || contractReviewTargetOptions.value[0]
          || null
      ));

      const contractReviewSelectedTargetAddress = computed(() => (
        contractReviewSelectedTarget.value?.address || state.contractReviewModal.address || ''
      ));

      const contractReviews = computed(() => (
        state.contractDetail?.reviews || []
      ));

      const contractAiAnalysis = computed(() => (
        state.contractDetail?.auto_analysis || {
          request_session: null,
          title: 'AI Auto Audit',
          provider: 'claude',
          model: DEFAULT_AI_PROVIDER_MODELS.claude[0],
          status: 'idle',
          requested_at: null,
          completed_at: null,
          critical: null,
          high: null,
          medium: null,
          report_path: null,
          error: null,
        }
      ));

      const tokenAiAnalysis = computed(() => (
        state.tokenDetail?.auto_analysis || {
          request_session: null,
          title: 'AI Auto Audit',
          provider: 'claude',
          model: DEFAULT_AI_PROVIDER_MODELS.claude[0],
          status: 'idle',
          requested_at: null,
          completed_at: null,
          critical: null,
          high: null,
          medium: null,
          report_path: null,
          error: null,
        }
      ));

      const sortedContractReviews = computed(() => (
        sortRows(contractReviews.value, 'reviewHistory', (a, b) => {
          const sort = getTableSort('reviewHistory');
          switch (sort.key) {
            case 'label':
              return compareString(a.label || '', b.label || '');
            case 'pattern':
              return compareString(a.pattern_hash || '', b.pattern_hash || '');
            case 'status':
              return compareString(a.status || '', b.status || '');
            case 'exploitable':
              return compareBoolean(a.exploitable, b.exploitable);
            case 'review':
              return compareString(a.review_text || '', b.review_text || '');
            case 'updated':
            default:
              return compareDate(a.updated_at, b.updated_at);
          }
        })
      ));

      const paginatedContractReviews = computed(() => (
        sortedContractReviews.value
      ));

      const sortedContractTokens = computed(() => (
        sortRows((state.contractDetail?.tokens || []), 'contractTokens', (a, b) => {
          const sort = getTableSort('contractTokens');
          switch (sort.key) {
            case 'token':
              return compareString(a.token?.token || '', b.token?.token || '');
            case 'symbol':
              return compareString(a.token?.token_symbol || '', b.token?.token_symbol || '');
            case 'price':
              return compareNumber(a.token?.token_price_usd, b.token?.token_price_usd);
            case 'sync':
              return compareString(syncStateLabel(a.token?.token_calls_sync), syncStateLabel(b.token?.token_calls_sync));
            case 'in':
              return compareBigInt(a.transfer_in_amount, b.transfer_in_amount);
            case 'out':
              return compareBigInt(a.transfer_out_amount, b.transfer_out_amount);
            case 'flow':
              return compareBigInt(a.total_token_flow, b.total_token_flow);
            case 'balance':
            default:
              return compareBigInt(a.current_balance, b.current_balance);
          }
        })
      ));

      const paginatedContractTokens = computed(() => (
        sortedContractTokens.value
      ));

      const contractFlowTokenOptions = computed(() => (
        state.prepared.contractDetail.flowTokenOptions || []
      ));

      const selectedContractFlowTokenRow = computed(() => {
        const rows = state.contractDetail?.tokens || [];
        if (!rows.length) return null;
        const selected = state.selectedContractFlowToken?.toLowerCase();
        return rows.find((row) => row.token?.token?.toLowerCase() === selected) || rows[0] || null;
      });

      const sortedContractTokenFlows = computed(() => {
        const rows = selectedContractFlowTokenRow.value?.flow_breakdown || [];
        return sortRows(rows, 'contractTokenFlows', (a, b) => {
          const sort = getTableSort('contractTokenFlows');
          switch (sort.key) {
            case 'counterparty':
              return compareString(a.label || a.address || '', b.label || b.address || '');
            case 'kind':
              return compareBoolean(a.is_contract, b.is_contract);
            case 'in_count':
              return compareNumber(a.transfer_in_count, b.transfer_in_count);
            case 'in_amount':
              return compareBigInt(a.transfer_in_amount, b.transfer_in_amount);
            case 'out_count':
              return compareNumber(a.transfer_out_count, b.transfer_out_count);
            case 'out_amount':
              return compareBigInt(a.transfer_out_amount, b.transfer_out_amount);
            case 'tx_count':
              return compareNumber(a.tx_count, b.tx_count);
            case 'total_flow':
            default:
              return compareBigInt(a.total_flow, b.total_flow);
          }
        });
      });

      const paginatedContractTokenFlows = computed(() => (
        sortedContractTokenFlows.value
      ));

      const sortedChainConfigs = computed(() => (
        sortRows((state.settings.chain_configs || []), 'chainConfig', (a, b) => {
          const sort = getTableSort('chainConfig');
          switch (sort.key) {
            case 'chain_id':
              return compareNumber(a.chain_id, b.chain_id);
            case 'blocks_per_scan':
              return compareNumber(a.blocks_per_scan, b.blocks_per_scan);
            case 'rpc_url_count':
              return compareNumber(countSettingLines(a.rpc_urls), countSettingLines(b.rpc_urls));
            case 'multicall3':
              return compareString(a.multicall3 || '', b.multicall3 || '');
            case 'chain':
            default:
              return compareString(a.chain || '', b.chain || '');
          }
        })
      ));

      const contractSelectorPreview = computed(() => (
        state.contractDetail?.selectors || []
      ));

      const contractStatusLabel = computed(() => {
        if (!state.contractDetail) return 'unloaded';
        if (state.contractDetail.is_exploitable) return 'exploitable';
        if (contractReviews.value.length > 0) return 'reviewed';
        return 'watching';
      });

      const contractStatusTone = computed(() => {
        if (!state.contractDetail) return 'warn';
        if (state.contractDetail.is_exploitable) return 'bad';
        if (contractReviews.value.length > 0) return 'ok';
        return 'warn';
      });

      const exploitableCount = computed(() => (
        state.dashboard.contracts.filter((row) => row.is_exploitable).length
      ));

      const topPortfolioUsd = computed(() => {
        const top = state.dashboard.contracts.reduce((max, row) => {
          const usd = Number(row.portfolio_usd);
          if (!Number.isFinite(usd)) return max;
          return Math.max(max, usd);
        }, 0);
        return Number.isFinite(top) ? top : null;
      });

      const syncMetaText = computed(() => {
        if (!state.syncStatus?.configured) return 'Sync not configured';
        const queue = state.syncStatus.queue || {};
        const pending = queue.pending || 0;
        const prepared = queue.prepared || 0;
        return `pending ${pending} | prepared ${prepared}`;
      });
      const syncStatusTone = computed(() => {
        if (!state.syncStatus?.configured) return 'warn';
        const prepared = Number(state.syncStatus?.queue?.prepared || 0);
        const failed = Number(state.syncStatus?.queue?.failed || 0);
        if (failed > 0) return 'bad';
        if (prepared > 0) return 'warn';
        return 'ok';
      });
      const syncHeaderText = computed(() => {
        if (!state.syncStatus?.configured) return 'Pattern sync disabled';
        const queue = state.syncStatus.queue || {};
        const pending = queue.pending || 0;
        const prepared = queue.prepared || 0;
        const failed = queue.failed || 0;
        const pushed = state.syncStatus.lastPushAt
          ? `push ${formatDateTime(state.syncStatus.lastPushAt)}`
          : 'push --';
        const pulled = state.syncStatus.lastPullAt
          ? `pull ${formatDateTime(state.syncStatus.lastPullAt)}`
          : 'pull --';
        return `auto sync | pending ${pending} | prepared ${prepared} | failed ${failed} | ${pushed} | ${pulled}`;
      });

      async function applyStatePayload(data) {
        const wasRunning = state.running;
        const previousRunningChain = state.runningChain;
        state.chains = data.chains || [];
        const explicitRouteChain = String(router.currentRoute.value?.query?.chain || '').toLowerCase();
        if (!state.selectedChain) {
          state.selectedChain = (
            explicitRouteChain
            || data.default_chain
            || state.chains[0]
            || ''
          ).toLowerCase();
        } else if (!explicitRouteChain && state.selectedChain && !state.chains.includes(state.selectedChain)) {
          state.selectedChain = (data.default_chain || state.chains[0] || '').toLowerCase();
        }
        state.latestRuns = data.latest_runs || [];
        state.running = Boolean(data.running);
        state.runningChain = data.running_chain || null;
        state.progress = data.progress || null;
        state.syncStatus = data.sync_status || null;
        state.autoAnalysis = data.auto_analysis || state.autoAnalysis;

        if (wasRunning && !state.running) {
          const completedChain = previousRunningChain || state.selectedChain;
          const latestCompletedRun = (data.latest_runs || []).find(
            (row) => String(row?.chain || '').toLowerCase() === String(completedChain || '').toLowerCase(),
          );
          const refreshKey = latestCompletedRun?.generated_at || data.progress?.updated_at || '';
          if (!hasRecentRunRefresh(completedChain, refreshKey)) {
            rememberRunRefresh(completedChain, refreshKey);
            invalidateChainCollectionCache(completedChain);
            if (currentView.value === 'dashboard') {
              if (state.dashboardTab === 'settings' || state.dashboardTab === 'auto') {
                await loadSettings({ showLoading: false, force: true });
              } else {
                await loadDashboardContracts({ showLoading: false, force: true });
              }
            } else if (currentView.value === 'token') {
              await loadDashboardTokens({ showLoading: false, force: true });
            }
          }
        }
      }

      const loaders = createDashboardLoaders({
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
      });

      const {
        loadDashboard,
        loadDashboardContracts,
        loadDashboardTokens,
        loadTokenDetail,
        loadContractDetail,
        loadSettings,
        refreshCurrent,
        loadViewDataForCurrentRoute,
        clearChainScopedData,
      } = loaders;

      const actions = createDashboardActions({
        state,
        currentView,
        autoAnalysisEnabled,
        contractAiAnalysis,
        tokenAiAnalysis,
        router,
        apiFetch,
        pushNotification,
        writeClipboardText,
        normalizeAiProvider,
        normalizeAiModel,
        autoAuditStatusLabel,
        prepareTokenDetail,
        prepareContractDetail,
        loaders,
        invalidateChainCache,
        updateUrl,
        dashboardUrlParams,
        rememberCurrentRouteContext,
        routeValueOrDefault,
        applySettingsPayload,
        tokenCacheKey,
        contractCacheKey,
        syncDashboardUrlState,
        viewDataCache,
        goBackToPrevious,
      });

      const {
        handleChainChanged,
        runScan,
        toggleAutoAnalysis,
        navigateDashboard,
        navigateToken,
        navigateContract,
        openDashboardMain,
        openAutoMode,
        openSettings,
        openToken,
        openContract,
        canRequestOverviewAutoAudit,
        canRequestTokenAutoAudit,
        requestOverviewAutoAudit,
        requestTokenAutoAudit,
        requestContractAnalysis,
        requestTokenAnalysis,
        openAiReport,
        openTokenAiReport,
        addAiProviderRow,
        removeAiProviderRow,
        addAiModelRow,
        removeAiModelRow,
        addWhitelistPatternRow,
        removeWhitelistPatternRow,
        saveSettings,
        saveReview,
        saveTokenReview,
        logout,
      } = actions;

      const modals = createDashboardModals({
        state,
        currentView,
        apiFetch,
        invalidateChainCache,
        loadDashboardContracts,
        loadDashboardTokens,
        loadTokenDetail,
        loadContractDetail,
        normalizeAiProvider,
        normalizeAiModel,
        contractReviewTargetOptions,
      });

      ({
        hydrateReviewForm,
        hydrateTokenReviewForm,
        toggleTokenReviewEditor,
        selectReviewTarget,
        buildContractReviewTargets,
        syncContractReviewModalForSelectedTarget,
        openContractReviewModal,
        closeContractReviewModal,
        openTokenReviewModal,
        closeTokenReviewModal,
        saveContractReviewModal,
        saveTokenReviewModal,
      } = modals);

      const routing = createDashboardRouting({
        state,
        router,
        currentView,
        startStateFetch: () => apiFetch('/api/state'),
        loadSettings,
        loadDashboardContracts,
        loadDashboardTokens,
        loadTokenDetail,
        loadContractDetail,
        loadViewDataForCurrentRoute,
        restoreCurrentScroll,
        applyStatePayload,
        rememberRunRefresh,
        hasRecentRunRefresh,
        invalidateChainCollectionCache,
        invalidateChainCache,
        pushNotification,
      });

      const { bootstrap } = routing;

      installDashboardViewState({
        onMounted,
        watch,
        router,
        state,
        currentView,
        routeToken,
        syncStateFromRoute,
        loadViewDataForCurrentRoute,
        restoreCurrentScroll,
        currentRelativeRoute,
        restoreScrollPosition,
        consumePendingRestoreState: () => {
          return consumePendingRestoreState();
        },
        persistCurrentScroll,
        persistScrollForRoute,
        syncDashboardUrlState,
        syncTokenUrlState,
        persistStoredFilters,
        resetTablePage,
        scheduleCollectionReload,
        normalizeAiProvider,
        normalizeAiModel,
        bootstrap,
      });

      function isCopiedAddress(value) {
        return Boolean(value) && state.copiedAddress === String(value).toLowerCase();
      }

      async function copyAddress(value) {
        if (!value) return;
        const normalized = String(value).trim();
        if (!normalized) return;

        try {
          await writeClipboardText(normalized);
          state.copiedAddress = normalized.toLowerCase();
          if (copiedAddressTimer) window.clearTimeout(copiedAddressTimer);
          copiedAddressTimer = window.setTimeout(() => {
            state.copiedAddress = '';
            copiedAddressTimer = null;
          }, 1000);
        } catch (err) {
          pushNotification(err instanceof Error ? err.message : 'Copy failed', 'error', 3200);
        }
      }

      function analysisStatusLabel(status) {
        switch (String(status || 'idle')) {
          case 'requested':
            return 'pending';
          case 'running':
            return 'running';
          case 'completed':
            return 'completed';
          case 'failed':
            return 'failed';
          default:
            return 'idle';
        }
      }

      function analysisStatusTone(status) {
        switch (String(status || 'idle')) {
          case 'completed':
            return 'ok';
          case 'failed':
            return 'bad';
          case 'requested':
          case 'running':
            return 'warn';
          default:
            return '';
        }
      }

      function analysisStatusHint(source) {
        const status = String(source?.status || 'idle');
        if (status === 'requested') return 'Pending and waiting for the backend worker.';
        if (status === 'running') return 'Audit is currently running.';
        if (status === 'completed') return 'Audit finished successfully.';
        if (status === 'failed') return 'Audit failed. You can retry with the same or a different model.';
        return 'Ready to request a fresh audit.';
      }

      function canRequestContractAnalysis() {
        const source = contractAiAnalysis.value;
        return source.status !== 'requested' && source.status !== 'running';
      }

      function canRequestTokenAnalysis() {
        const source = tokenAiAnalysis.value;
        return source.status !== 'requested' && source.status !== 'running';
      }

      function analysisRequestButtonLabel() {
        const source = contractAiAnalysis.value;
        if (source.status === 'completed') return 'Re-run AI Analysis';
        if (source.status === 'requested') return 'Pending';
        if (source.status === 'running') return 'Running';
        if (source.status === 'failed') return 'Retry AI Analysis';
        return 'Request AI Analysis';
      }

      function tokenAnalysisRequestButtonLabel() {
        const source = tokenAiAnalysis.value;
        if (source.status === 'completed') return 'Re-run AI Analysis';
        if (source.status === 'requested') return 'Pending';
        if (source.status === 'running') return 'Running';
        if (source.status === 'failed') return 'Retry AI Analysis';
        return 'Request AI Analysis';
      }

      return {
        chains: computed(() => state.chains),
        selectedChain: computed({
          get: () => state.selectedChain,
          set: (value) => { state.selectedChain = (value || '').toLowerCase(); },
        }),
        latestRuns: state.latestRuns,
        running: computed(() => state.running),
        progress: computed(() => state.progress),
        dashboardTab: computed({
          get: () => state.dashboardTab,
          set: (value) => { state.dashboardTab = value; },
        }),
        settingsSection: computed({
          get: () => state.settingsSection,
          set: (value) => { state.settingsSection = value; },
        }),
        dashboard: state.dashboard,
        dashboardFilters: state.dashboardFilters,
        selectedContractFlowToken: computed({
          get: () => state.selectedContractFlowToken,
          set: (value) => { state.selectedContractFlowToken = String(value || '').toLowerCase(); },
        }),
        tokenDetail: computed(() => state.tokenDetail),
        contractDetail: computed(() => state.contractDetail),
        settings: state.settings,
        syncStatus: computed(() => state.syncStatus),
        autoAnalysisStatus,
        autoAnalysisEnabled,
        autoAnalysisButtonLabel,
        autoAnalysisChipTone,
        autoAnalysisMetaText,
        autoAnalysisDetailText,
        authEnabled: computed(() => state.authEnabled),
        currentUser: computed(() => state.currentUser),
        reviewForm: state.reviewForm,
        contractReviewModal: state.contractReviewModal,
        tokenReviewModal: state.tokenReviewModal,
        tokenReviewForm: state.tokenReviewForm,
        tokenReviewExpanded: computed({
          get: () => state.tokenReviewExpanded,
          set: (value) => { state.tokenReviewExpanded = Boolean(value); },
        }),
        analysisForm: state.analysisForm,
        currentView,
        routeToken,
        routeContract,
        runMetaText,
        syncMetaText,
        syncStatusTone,
        syncHeaderText,
        progressPercent,
        progressLabel,
        progressStageLabel,
        progressDetailText,
        progressStatusTone,
        pageSizeOptions: PAGE_SIZE_OPTIONS,
        getTablePaginationMeta,
        canMoveTablePage,
        moveTablePage,
        goToTablePage,
        getTablePageButtons,
        getTablePageSize,
        setTablePageSize,
        pageLoading: computed(() => state.pageLoading.count > 0),
        pageLoadingLabel: computed(() => state.pageLoading.label || 'Loading'),
        notifications: computed(() => state.notifications),
        filteredTokens,
        paginatedFilteredTokens,
        filteredContracts,
        paginatedFilteredContracts,
        contractOverviewSections,
        tokenContracts,
        filteredTokenContracts,
        sortedTokenContracts,
        paginatedTokenContracts,
        tokenContractSections,
        tokenGroupCards,
        tokenExploitableCount,
        tokenLargestBalance,
        tokenAiAnalysis,
        contractPatternTargets,
        contractReviewTargetOptions,
        contractReviewSelectedTargetAddress,
        contractReviews,
        contractAiAnalysis,
        sortedContractReviews,
        paginatedContractReviews,
        sortedContractTokens,
        paginatedContractTokens,
        contractFlowTokenOptions,
        selectedContractFlowTokenRow,
        sortedContractTokenFlows,
        paginatedContractTokenFlows,
        sortedChainConfigs,
        contractSelectorPreview,
        contractStatusLabel,
        contractStatusTone,
        exploitableCount,
        topPortfolioUsd,
        formatUsd,
        formatBig,
        formatTokenAmount,
        formatDateTime,
        formatRelativeTime,
        shortAddress,
        syncStateLabel,
        syncStateTone,
        autoAuditStatusLabel,
        autoAuditStatusTone,
        autoAuditSeveritySummary,
        auditResultDisplay,
        refreshCurrent,
        handleChainChanged,
        runScan,
        toggleAutoAnalysis,
        navigateDashboard,
        openDashboardMain,
        openAutoMode,
        openSettings,
        navigateToken,
        navigateContract,
        goBackToPrevious,
        openToken,
        openContract,
        toggleTableSort,
        sortIndicator,
        isActiveSort,
        copyAddress,
        isCopiedAddress,
        contractToneClass,
        tokenToneClass,
        toggleGroupCollapse,
        selectReviewTarget,
        syncContractReviewModalForSelectedTarget,
        openContractReviewModal,
        closeContractReviewModal,
        saveContractReviewModal,
        openTokenReviewModal,
        closeTokenReviewModal,
        saveTokenReviewModal,
        analysisStatusLabel,
        analysisStatusTone,
        analysisStatusHint,
        canRequestTokenAnalysis,
        canRequestContractAnalysis,
        canRequestOverviewAutoAudit,
        canRequestTokenAutoAudit,
        analysisRequestButtonLabel,
        tokenAnalysisRequestButtonLabel,
        requestOverviewAutoAudit,
        requestTokenAutoAudit,
        requestTokenAnalysis,
        requestContractAnalysis,
        openAiReport,
        openTokenAiReport,
        toggleTokenReviewEditor,
        saveSettings,
        addAiProviderRow,
        removeAiProviderRow,
        addAiModelRow,
        removeAiModelRow,
        addWhitelistPatternRow,
        removeWhitelistPatternRow,
        saveReview,
        saveTokenReview,
        dismissNotification,
        logout,
        aiProviderOptions,
        aiModelOptions,
        autoAnalysisProviderOptions,
        autoAnalysisModelOptions,
      };
    },
  });

  try {
    app.use(pinia);
    app.use(router);
    appRoot?.removeAttribute('v-cloak');
    app.mount('#app');
  } catch (err) {
    if (appRoot) {
      appRoot.removeAttribute('v-cloak');
      appRoot.innerHTML = `
        <section class="card app-error-card">
          <div class="card-head">
            <h2>Frontend Mount Failed</h2>
            <span class="muted">Dashboard bootstrap error</span>
          </div>
          <p class="muted">${String(err instanceof Error ? err.message : err)}</p>
        </section>
      `;
    }
    console.error(err);
  }
})();
