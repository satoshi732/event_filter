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

  function toRouteQueryObject(value) {
    if (!value) return {};
    if (typeof value === 'string') {
      const params = new URLSearchParams(value.startsWith('?') ? value.slice(1) : value);
      const result = {};
      params.forEach((entry, key) => {
        result[key] = entry;
      });
      return result;
    }
    return value;
  }

  function routeStorageKey(routeLike) {
    const path = String(routeLike?.path || routeLike?.name || window.location.pathname || '/');
    const queryObject = toRouteQueryObject(routeLike?.query || '');
    const parts = Object.entries(queryObject)
      .filter(([, value]) => value != null && value !== '')
      .sort(([left], [right]) => compareString(left, right))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    return parts.length ? `${path}?${parts.join('&')}` : path;
  }

  function currentRelativeRoute() {
    return routeStorageKey(router?.currentRoute?.value || { path: window.location.pathname, query: window.location.search });
  }

  function rememberCurrentRoute() {
    try {
      window.sessionStorage.setItem(PREV_ROUTE_STORAGE_KEY, currentRelativeRoute());
    } catch {}
  }

  function rememberCurrentRouteScroll() {
    try {
      window.sessionStorage.setItem(
        PREV_ROUTE_SCROLL_STORAGE_KEY,
        String(window.scrollY || window.pageYOffset || 0),
      );
    } catch {}
  }


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
        recentRunRefreshes.set(normalizedChain, normalizedKey);
      }

      function hasRecentRunRefresh(chain, refreshKey) {
        const normalizedChain = chainCacheKey(chain);
        const normalizedKey = String(refreshKey || '').trim();
        if (!normalizedChain || !normalizedKey) return false;
        return recentRunRefreshes.get(normalizedChain) === normalizedKey;
      }

      let copiedAddressTimer = null;
      let stateEventSource = null;
      let stateStreamReadyPromise = null;
      let resolveStateStreamReady = null;
      let stateStreamReady = false;
      let pendingExplicitRestoreKey = '';
      let pendingExplicitRestorePosition = 0;
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

      function getTableSort(tableId) {
        return state.tableSorts[tableId] || { key: '', dir: 'asc' };
      }

      function persistTableSorts() {
        writeJsonStorage(window.localStorage, SORT_STORAGE_KEY, state.tableSorts);
      }

      function persistCollapsedGroups() {
        persistStoredCollapsedGroups(state.collapsedGroups);
      }

      function toggleTableSort(tableId, key) {
        const current = getTableSort(tableId);
        state.tableSorts[tableId] = {
          key,
          dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc',
        };
        if (Object.prototype.hasOwnProperty.call(state.tablePages, tableId)) {
          state.tablePages[tableId] = 1;
        }
        persistTableSorts();
      }

      function sortIndicator(tableId, key) {
        const current = getTableSort(tableId);
        if (current.key !== key) return '';
        return current.dir === 'asc' ? '▲' : '▼';
      }

      function isActiveSort(tableId, key) {
        return getTableSort(tableId).key === key;
      }

      function getTablePageSize(tableId) {
        return Math.max(1, Number(state.tablePageSizes?.[tableId] || TABLE_PAGE_SIZE[tableId] || 25));
      }

      function getTablePage(tableId) {
        return Math.max(1, Number(state.tablePages?.[tableId] || 1));
      }

      function getTableRowCount(tableId) {
        switch (tableId) {
          case 'contractOverview':
            return Number(state.listMeta.contractOverview?.totalRows || 0);
          case 'tokenDirectory':
            return Number(state.listMeta.tokenDirectory?.totalRows || 0);
          case 'tokenRelatedContracts':
            return sortedTokenContracts.value.length;
          default:
            return 0;
        }
      }

      function getTableTotalPages(tableId, totalRowsOverride) {
        const totalRows = Number(
          totalRowsOverride == null ? getTableRowCount(tableId) : totalRowsOverride,
        ) || 0;
        return Math.max(1, Math.ceil(totalRows / getTablePageSize(tableId)));
      }

      function setTablePage(tableId, page) {
        if (!Object.prototype.hasOwnProperty.call(state.tablePages, tableId)) return;
        const totalPages = getTableTotalPages(tableId);
        state.tablePages[tableId] = Math.max(1, Math.min(totalPages, Math.floor(Number(page) || 1)));
      }

      function resetTablePage(tableId) {
        if (!Object.prototype.hasOwnProperty.call(state.tablePages, tableId)) return;
        state.tablePages[tableId] = 1;
      }

      function setTablePageSize(tableId, size) {
        if (!Object.prototype.hasOwnProperty.call(state.tablePageSizes, tableId)) return;
        const normalizedSize = PAGE_SIZE_OPTIONS.includes(Number(size))
          ? Number(size)
          : (TABLE_PAGE_SIZE[tableId] || 25);
        if (getTablePageSize(tableId) === normalizedSize) return;
        state.tablePageSizes[tableId] = normalizedSize;
        resetTablePage(tableId);
        persistStoredPageSizes(state.tablePageSizes);
        if (tableId === 'contractOverview' && currentView.value === 'dashboard' && state.dashboardTab === 'tokens') {
          scheduleCollectionReload('contracts');
        }
        if (tableId === 'tokenDirectory' && currentView.value === 'token') {
          scheduleCollectionReload('tokens');
        }
      }

      function paginateRows(rows, tableId) {
        const list = Array.isArray(rows) ? rows : [];
        const totalPages = getTableTotalPages(tableId, list.length);
        const page = Math.max(1, Math.min(getTablePage(tableId), totalPages));
        if (page !== getTablePage(tableId) && Object.prototype.hasOwnProperty.call(state.tablePages, tableId)) {
          state.tablePages[tableId] = page;
        }
        const pageSize = getTablePageSize(tableId);
        const start = (page - 1) * pageSize;
        return list.slice(start, start + pageSize);
      }

      function getTablePaginationMeta(tableId, totalRowsOverride) {
        const totalRows = Number(
          totalRowsOverride == null ? getTableRowCount(tableId) : totalRowsOverride,
        ) || 0;
        const totalPages = getTableTotalPages(tableId, totalRows);
        const page = Math.max(1, Math.min(getTablePage(tableId), totalPages));
        const pageSize = getTablePageSize(tableId);
        const start = totalRows ? ((page - 1) * pageSize) + 1 : 0;
        const end = totalRows ? Math.min(totalRows, page * pageSize) : 0;
        return { page, totalPages, totalRows, start, end };
      }

      function canMoveTablePage(tableId, direction) {
        const meta = getTablePaginationMeta(tableId);
        return direction < 0 ? meta.page > 1 : meta.page < meta.totalPages;
      }

      function moveTablePage(tableId, direction) {
        setTablePage(tableId, getTablePage(tableId) + direction);
      }

      function goToTablePage(tableId, page) {
        setTablePage(tableId, page);
      }

      function getTablePageButtons(tableId, totalRowsOverride) {
        const meta = getTablePaginationMeta(tableId, totalRowsOverride);
        if (meta.totalPages <= 1) return [1];
        const pages = new Set([1, meta.totalPages, meta.page - 1, meta.page, meta.page + 1]);
        if (meta.page <= 3) {
          pages.add(2);
          pages.add(3);
        }
        if (meta.page >= meta.totalPages - 2) {
          pages.add(meta.totalPages - 1);
          pages.add(meta.totalPages - 2);
        }
        return [...pages]
          .filter((page) => page >= 1 && page <= meta.totalPages)
          .sort((left, right) => left - right)
          .reduce((acc, page) => {
            if (acc.length && typeof acc[acc.length - 1] === 'number' && page - acc[acc.length - 1] > 1) {
              acc.push('ellipsis');
            }
            acc.push(page);
            return acc;
          }, []);
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

      function persistCurrentScroll() {
        persistScrollForRoute(router.currentRoute.value);
      }

      function rememberCurrentRouteContext() {
        rememberCurrentRoute();
        rememberCurrentRouteScroll();
        persistCurrentScroll();
      }

      function persistScrollForRoute(routeLike, position) {
        const positions = readJsonStorage(window.sessionStorage, SCROLL_STORAGE_KEY, {});
        positions[routeStorageKey(routeLike)] = Number.isFinite(Number(position))
          ? Number(position)
          : (window.scrollY || window.pageYOffset || 0);
        writeJsonStorage(window.sessionStorage, SCROLL_STORAGE_KEY, positions);
      }

      async function restoreCurrentScroll(routeLike = router.currentRoute.value) {
        await nextTick();
        const positions = readJsonStorage(window.sessionStorage, SCROLL_STORAGE_KEY, {});
        const target = Number(positions[routeStorageKey(routeLike)] || 0);
        if (!Number.isFinite(target) || target <= 0) return;
        restoreScrollPosition(target);
      }

      function restoreScrollPosition(target) {
        const attempts = [0, 80, 180, 320];
        attempts.forEach((delay) => {
          window.setTimeout(() => {
            window.requestAnimationFrame(() => {
              window.scrollTo(0, target);
            });
          }, delay);
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

      const sortedTokenContracts = computed(() => (
        sortRows(tokenContracts.value, 'tokenRelatedContracts', (a, b) => {
          const sort = getTableSort('tokenRelatedContracts');
          switch (sort.key) {
            case 'contract':
              return compareString(a.contract, b.contract);
            case 'group':
              return compareString(a.group_label || '', b.group_label || '');
            case 'label':
              return compareString(a.seen_label || '', b.seen_label || '');
            case 'patterns':
              return compareString((a.whitelist_patterns || []).join(','), (b.whitelist_patterns || []).join(','));
            case 'in':
              return compareBigInt(a.transfer_in_amount, b.transfer_in_amount);
            case 'out':
              return compareBigInt(a.transfer_out_amount, b.transfer_out_amount);
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

      async function updateUrl(path, params = {}) {
        const queryParams = {};
        Object.entries(params).forEach(([key, value]) => {
          if (value == null || value === '') return;
          queryParams[key] = String(value);
        });

        const nextRouteKey = routeStorageKey({ path, query: queryParams });
        const currentRouteKey = routeStorageKey(router.currentRoute.value);
        if (nextRouteKey === currentRouteKey) return;

        const currentScroll = window.scrollY || window.pageYOffset || 0;
        persistScrollForRoute(router.currentRoute.value, currentScroll);
        await router.replace({ path, query: queryParams }).catch(() => {});
        persistScrollForRoute({ path, query: queryParams }, currentScroll);
      }

      function dashboardUrlParams() {
        return {
          chain: state.selectedChain,
          tab: state.dashboardTab,
          st: state.dashboardTab === 'settings' ? state.settingsSection : '',
        };
      }

      function syncDashboardUrlState() {
        if (currentView.value !== 'dashboard') return;
        updateUrl('/', dashboardUrlParams());
      }

      function syncTokenUrlState() {
        if (currentView.value !== 'token') return;
        updateUrl('/token', {
          chain: state.selectedChain,
        });
      }

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

      function startStateStream() {
        if (stateEventSource) return stateStreamReadyPromise || Promise.resolve();
        try {
          stateStreamReadyPromise = new Promise((resolve) => {
            resolveStateStreamReady = resolve;
          });
          stateEventSource = new EventSource('/api/state/stream');
          stateEventSource.addEventListener('state', (event) => {
            try {
              const payload = JSON.parse(event.data);
              void applyStatePayload(payload);
              if (!stateStreamReady) {
                stateStreamReady = true;
                resolveStateStreamReady?.();
                resolveStateStreamReady = null;
              }
            } catch (err) {
              console.error(err);
            }
          });
          stateEventSource.addEventListener('ai-audit', (event) => {
            try {
              const payload = JSON.parse(event.data);
              void handleAiAuditSse(payload);
            } catch (err) {
              console.error(err);
            }
          });
          stateEventSource.addEventListener('auto-analysis', (event) => {
            try {
              const payload = JSON.parse(event.data);
              handleAutoAnalysisSse(payload);
            } catch (err) {
              console.error(err);
            }
          });
          stateEventSource.addEventListener('pattern-sync', (event) => {
            try {
              const payload = JSON.parse(event.data);
              handlePatternSyncSse(payload);
            } catch (err) {
              console.error(err);
            }
          });
          stateEventSource.addEventListener('review-updated', (event) => {
            try {
              const payload = JSON.parse(event.data);
              void handleReviewUpdatedSse(payload);
            } catch (err) {
              console.error(err);
            }
          });
          stateEventSource.addEventListener('data-refresh', (event) => {
            try {
              const payload = JSON.parse(event.data);
              void handleDataRefreshSse(payload);
            } catch (err) {
              console.error(err);
            }
          });
          stateEventSource.onerror = () => {
            // EventSource reconnects automatically. Keep the stream open unless closed explicitly.
          };
        } catch (err) {
          console.error(err);
          stateStreamReadyPromise = Promise.resolve();
        }
        return stateStreamReadyPromise;
      }

      async function handleAiAuditSse(payload) {
        const chain = String(payload?.chain || '').toLowerCase();
        const targetType = String(payload?.targetType || '').toLowerCase();
        const targetAddr = String(payload?.targetAddr || '').toLowerCase();
        if (!chain || !targetType || !targetAddr) return;

        invalidateChainCache(chain);
        if (chain !== state.selectedChain) return;

        if (currentView.value === 'token-detail') {
          const tokenAddr = String(state.route.token || '').toLowerCase();
          if (targetType === 'token' && tokenAddr === targetAddr) {
            await loadTokenDetail({ showLoading: false, force: true });
            return;
          }
          if (targetType === 'contract') {
            const hasContract = (state.prepared.tokenDetail?.contractsFlat || []).some(
              (row) => String(row?.contract || '').toLowerCase() === targetAddr,
            );
            if (hasContract) {
              await loadTokenDetail({ showLoading: false, force: true });
              return;
            }
          }
        }

        if (currentView.value === 'contract') {
          const contractAddr = String(state.route.contract || '').toLowerCase();
          if (targetType === 'contract' && contractAddr === targetAddr) {
            await loadContractDetail({ showLoading: false, force: true });
            return;
          }
        }

        if (currentView.value === 'token' && targetType === 'token') {
          await loadDashboardTokens({ showLoading: false, force: true });
          return;
        }

        if (currentView.value === 'dashboard' && state.dashboardTab === 'tokens' && targetType === 'contract') {
          await loadDashboardContracts({ showLoading: false, force: true });
        }
      }

      function handleAutoAnalysisSse(payload) {
        if (!payload || typeof payload !== 'object') return;
        state.autoAnalysis = payload;
      }

      function handlePatternSyncSse(payload) {
        const status = payload?.status;
        if (status && typeof status === 'object') {
          state.syncStatus = status;
        }
      }

      async function handleReviewUpdatedSse(payload) {
        const chain = String(payload?.chain || '').toLowerCase();
        const targetType = String(payload?.targetType || '').toLowerCase();
        const targetAddr = String(payload?.targetAddr || '').toLowerCase();
        if (!chain || !targetType || !targetAddr) return;

        invalidateChainCache(chain);
        if (chain !== state.selectedChain) return;

        if (currentView.value === 'token-detail') {
          const tokenAddr = String(state.route.token || '').toLowerCase();
          if (targetType === 'token' && tokenAddr === targetAddr) {
            await loadTokenDetail({ showLoading: false, force: true });
            return;
          }
          if (targetType === 'contract') {
            const hasContract = (state.prepared.tokenDetail?.contractsFlat || []).some(
              (row) => String(row?.contract || '').toLowerCase() === targetAddr,
            );
            if (hasContract) {
              await loadTokenDetail({ showLoading: false, force: true });
              return;
            }
          }
        }

        if (currentView.value === 'contract') {
          const contractAddr = String(state.route.contract || '').toLowerCase();
          if (targetType === 'contract' && contractAddr === targetAddr) {
            await loadContractDetail({ showLoading: false, force: true });
            return;
          }
        }

        if (currentView.value === 'token' && targetType === 'token') {
          await loadDashboardTokens({ showLoading: false, force: true });
          return;
        }

        if (currentView.value === 'dashboard' && state.dashboardTab === 'tokens' && targetType === 'contract') {
          await loadDashboardContracts({ showLoading: false, force: true });
        }
      }

      async function handleDataRefreshSse(payload) {
        const chain = String(payload?.chain || '').toLowerCase();
        const kind = String(payload?.kind || '').toLowerCase();
        if (!chain || chain !== state.selectedChain || kind !== 'run-completed') return;

        rememberRunRefresh(chain, payload?.run?.generated_at || payload?.ts || '');
        invalidateChainCollectionCache(chain);
        if (currentView.value === 'dashboard') {
          if (state.dashboardTab === 'settings' || state.dashboardTab === 'auto') {
            await loadSettings({ showLoading: false, force: true });
          } else {
            await loadDashboardContracts({ showLoading: false, force: true });
          }
          return;
        }
        if (currentView.value === 'token') {
          await loadDashboardTokens({ showLoading: false, force: true });
          return;
        }
      }

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
          const cached = viewDataCache.dashboardContracts.get(cacheKey);
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
            viewDataCache.dashboardContracts.set(cacheKey, payload);
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
          const cached = viewDataCache.dashboardTokens.get(cacheKey);
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
            viewDataCache.dashboardTokens.set(cacheKey, payload);
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
          const cached = viewDataCache.tokenDetail.get(cacheKey);
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
            viewDataCache.tokenDetail.set(cacheKey, payload);
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
          const cached = viewDataCache.contractDetail.get(cacheKey);
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
            viewDataCache.contractDetail.set(cacheKey, payload);
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
          const data = viewDataCache.settings;
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
          return;
        }
        await runSharedLoad('settings', async () => {
          const data = options.showLoading === false
            ? await apiFetch('/api/settings')
            : await withPageLoading('Loading settings', () => apiFetch('/api/settings'));
          viewDataCache.settings = data;
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

      async function handleChainChanged() {
        clearChainScopedData();
        if (currentView.value === 'dashboard') {
          await updateUrl('/', dashboardUrlParams());
          if (state.dashboardTab === 'settings' || state.dashboardTab === 'auto') {
            await loadSettings();
            return;
          }
          await refreshCurrent();
          return;
        }
        if (currentView.value === 'token') {
          await updateUrl('/token', {
            chain: state.selectedChain,
          });
          await loadDashboardTokens();
          return;
        }
        if (currentView.value === 'token-detail') {
          await updateUrl('/token-detail', { chain: state.selectedChain, token: state.route.token });
          await refreshCurrent();
          return;
        }
        await updateUrl('/contract', { chain: state.selectedChain, contract: state.route.contract });
        await refreshCurrent();
      }

      async function runScan() {
        if (!state.selectedChain || state.running) return;
        state.running = true;
        state.runningChain = state.selectedChain;
        state.progress = {
          chain: state.selectedChain,
          stage: 'boot',
          label: 'Starting pipeline round',
          percent: 1,
          updated_at: new Date().toISOString(),
        };
        try {
          await apiFetch('/api/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chain: state.selectedChain }),
          });
          await refreshCurrent();
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        } finally {
          state.running = false;
        }
      }

      async function toggleAutoAnalysis() {
        if (!state.selectedChain && !autoAnalysisEnabled.value) return;
        try {
          const data = autoAnalysisEnabled.value
            ? await apiFetch('/api/auto-analysis/stop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            })
            : await apiFetch('/api/auto-analysis/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chain: state.selectedChain }),
            });
          state.autoAnalysis = data.status || state.autoAnalysis;
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }

      function navigateDashboard() {
        rememberCurrentRouteContext();
        router.push({ path: '/', query: dashboardUrlParams() }).catch(() => {});
      }

      function navigateToken() {
        rememberCurrentRouteContext();
        router.push({
          path: '/token',
          query: {
            chain: state.selectedChain,
          },
        }).catch(() => {});
      }

      function navigateContract() {
        rememberCurrentRouteContext();
        if (state.route.contract) {
          router.push({
            path: '/contract',
            query: { chain: state.selectedChain, contract: state.route.contract },
          }).catch(() => {});
        } else if (state.dashboard.contracts[0]?.contract) {
          openContract(state.dashboard.contracts[0].contract);
        }
      }

      function openDashboardMain() {
        state.dashboardTab = 'tokens';
        navigateDashboard();
      }

      function openAutoMode() {
        state.dashboardTab = 'auto';
        if (currentView.value === 'dashboard') {
          syncDashboardUrlState();
          return;
        }
        navigateDashboard();
      }

      function openSettings(section = 'keys') {
        state.dashboardTab = 'settings';
        state.settingsSection = section;
        if (currentView.value === 'dashboard') {
          syncDashboardUrlState();
          return;
        }
        navigateDashboard();
      }

      function openToken(token) {
        rememberCurrentRouteContext();
        router.push({
          path: '/token-detail',
          query: { chain: state.selectedChain, token: String(token || '').toLowerCase() },
        }).catch(() => {});
      }

      function openContract(contract) {
        rememberCurrentRouteContext();
        router.push({
          path: '/contract',
          query: { chain: state.selectedChain, contract: String(contract || '').toLowerCase() },
        }).catch(() => {});
      }

      function goBackToPrevious(fallbackView = 'dashboard') {
        persistCurrentScroll();
        try {
          const previous = window.sessionStorage.getItem(PREV_ROUTE_STORAGE_KEY);
          const previousScroll = Number(window.sessionStorage.getItem(PREV_ROUTE_SCROLL_STORAGE_KEY) || 0);
          if (previous && previous !== currentRelativeRoute()) {
            pendingExplicitRestoreKey = previous;
            pendingExplicitRestorePosition = Number.isFinite(previousScroll) ? previousScroll : 0;
            router.push(previous).catch(() => {});
            return;
          }
        } catch {}

        if (fallbackView === 'token') {
          router.push({
            path: '/token',
            query: { chain: state.selectedChain },
          }).catch(() => {});
          return;
        }

        router.push({
          path: '/',
          query: { chain: state.selectedChain },
        }).catch(() => {});
      }

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
          window.alert(err instanceof Error ? err.message : 'Copy failed');
        }
      }

      function hydrateReviewForm() {
        const detail = state.contractDetail;
        const firstTarget = detail?.pattern_targets?.[0]?.kind;
        state.reviewForm.target_kind = firstTarget || 'contract';
        state.reviewForm.label = detail?.label || '';
        state.reviewForm.review_text = detail?.review || '';
        state.reviewForm.exploitable = Boolean(detail?.is_exploitable);
        state.analysisForm.title = detail?.auto_analysis?.title || 'AI Auto Audit';
        state.analysisForm.provider = normalizeAiProvider(detail?.auto_analysis?.provider);
        state.analysisForm.model = normalizeAiModel(state.analysisForm.provider, detail?.auto_analysis?.model);
      }

      function hydrateTokenReviewForm() {
        const detail = state.tokenDetail;
        state.tokenReviewForm.review_text = detail?.review || '';
        state.tokenReviewForm.exploitable = Boolean(detail?.is_exploitable);
        state.tokenReviewExpanded = false;
      }

      function toggleTokenReviewEditor(force) {
        if (typeof force === 'boolean') {
          state.tokenReviewExpanded = force;
          return;
        }
        state.tokenReviewExpanded = !state.tokenReviewExpanded;
      }

      function selectReviewTarget(target) {
        state.reviewForm.target_kind = target?.kind || 'contract';
        if (!state.reviewForm.label.trim()) {
          state.reviewForm.label = target?.seen_label || state.contractDetail?.label || '';
        }
      }

      function buildContractReviewTargets(row) {
        const options = [];
        const seen = new Set();

        function pushTarget(kind, address, patternHash = '') {
          const normalizedKind = String(kind || '').trim().toLowerCase();
          const normalizedAddress = String(address || '').trim().toLowerCase();
          if (!normalizedKind || !normalizedAddress) return;
          const key = `${normalizedKind}:${normalizedAddress}`;
          if (seen.has(key)) return;
          seen.add(key);
          options.push({
            kind: normalizedKind,
            address: normalizedAddress,
            pattern_hash: patternHash ? String(patternHash) : '',
          });
        }

        if (Array.isArray(row?.pattern_targets) && row.pattern_targets.length) {
          row.pattern_targets.forEach((target) => {
            pushTarget(target.kind, target.address, target.pattern_hash);
          });
        } else {
          pushTarget('contract', row?.contract || row?.address);
          if (row?.proxy_impl || (row?.link_type === 'proxy' && row?.linkage)) {
            pushTarget('implementation', row?.proxy_impl || row?.linkage);
          }
          if (row?.eip7702_delegate || (row?.link_type === 'eip7702' && row?.linkage)) {
            pushTarget('delegate', row?.eip7702_delegate || row?.linkage);
          }
        }

        if (!options.length) {
          pushTarget('contract', row?.contract || row?.address);
        }

        return options;
      }

      function syncContractReviewModalForSelectedTarget() {
        const row = state.contractReviewModal.row;
        const selectedTarget = buildContractReviewTargets(row).find(
          (target) => target.kind === state.contractReviewModal.target_kind,
        ) || contractReviewTargetOptions.value[0] || null;
        const existingReview = (row?.reviews || []).find((review) => {
          if (selectedTarget?.pattern_hash && review.pattern_hash === selectedTarget.pattern_hash) return true;
          if (selectedTarget?.address && review.pattern_address === selectedTarget.address) return true;
          return selectedTarget?.kind && review.pattern_kind === selectedTarget.kind;
        });

        state.contractReviewModal.label = String(
          existingReview?.label
          || row?.label
          || row?.seen_label
          || state.contractDetail?.label
          || '',
        ).trim();
        state.contractReviewModal.review_text = String(existingReview?.review_text || '').trim();
        state.contractReviewModal.exploitable = existingReview
          ? Boolean(existingReview.exploitable)
          : Boolean(row?.is_exploitable);
      }

      function openContractReviewModal(row, source = 'table') {
        if (!row?.contract) return;
        const targetOptions = buildContractReviewTargets(row);
        state.contractReviewModal.open = true;
        state.contractReviewModal.address = String(row.contract || '').toLowerCase();
        state.contractReviewModal.target_options = targetOptions;
        state.contractReviewModal.target_kind = targetOptions[0]?.kind || 'contract';
        state.contractReviewModal.label = '';
        state.contractReviewModal.review_text = '';
        state.contractReviewModal.exploitable = Boolean(row.is_exploitable);
        state.contractReviewModal.row = row;
        state.contractReviewModal.source = source;
        state.contractReviewModal.saving = false;
        state.contractReviewModal.error = '';
        syncContractReviewModalForSelectedTarget();
      }

      function closeContractReviewModal() {
        state.contractReviewModal.open = false;
        state.contractReviewModal.row = null;
        state.contractReviewModal.target_options = [];
        state.contractReviewModal.saving = false;
        state.contractReviewModal.error = '';
      }

      function openTokenReviewModal(row) {
        if (!row?.token) return;
        state.tokenReviewModal.open = true;
        state.tokenReviewModal.address = String(row.token || '').toLowerCase();
        state.tokenReviewModal.name = String(row.token_name || '').trim();
        state.tokenReviewModal.symbol = String(row.token_symbol || '').trim();
        state.tokenReviewModal.review_text = String(row.review || '').trim();
        state.tokenReviewModal.exploitable = Boolean(row.is_exploitable);
        state.tokenReviewModal.saving = false;
        state.tokenReviewModal.error = '';
      }

      function closeTokenReviewModal() {
        state.tokenReviewModal.open = false;
        state.tokenReviewModal.saving = false;
        state.tokenReviewModal.error = '';
      }

      async function saveContractReviewModal() {
        if (!state.contractReviewModal.address) return;
        if (!state.contractReviewModal.label.trim()) {
          state.contractReviewModal.error = 'Label is required.';
          return;
        }
        state.contractReviewModal.saving = true;
        state.contractReviewModal.error = '';
        try {
          await apiFetch('/api/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: state.selectedChain,
              address: state.contractReviewModal.address,
              target_kind: state.contractReviewModal.target_kind,
              label: state.contractReviewModal.label.trim(),
              review_text: state.contractReviewModal.review_text,
              exploitable: state.contractReviewModal.exploitable,
            }),
          });
          invalidateChainCache(state.selectedChain);
          if (currentView.value === 'token-detail') {
            await loadTokenDetail({ force: true });
          } else {
            await loadDashboardContracts({ showLoading: false, force: true });
          }
          if (state.contractDetail?.address === state.contractReviewModal.address) {
            await loadContractDetail({ force: true });
          }
          closeContractReviewModal();
        } catch (err) {
          state.contractReviewModal.error = err instanceof Error ? err.message : String(err);
        } finally {
          state.contractReviewModal.saving = false;
        }
      }

      async function saveTokenReviewModal() {
        if (!state.tokenReviewModal.address) return;
        state.tokenReviewModal.saving = true;
        state.tokenReviewModal.error = '';
        try {
          await apiFetch('/api/token-review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: state.selectedChain,
              token: state.tokenReviewModal.address,
              review_text: state.tokenReviewModal.review_text,
              exploitable: state.tokenReviewModal.exploitable,
            }),
          });
          invalidateChainCache(state.selectedChain);
          if (currentView.value === 'token') {
            await loadDashboardTokens({ showLoading: false, force: true });
          }
          if (state.tokenDetail?.token === state.tokenReviewModal.address) {
            await loadTokenDetail({ force: true });
          }
          closeTokenReviewModal();
        } catch (err) {
          state.tokenReviewModal.error = err instanceof Error ? err.message : String(err);
        } finally {
          state.tokenReviewModal.saving = false;
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

      function buildPendingAutoAnalysis(analysis, fallback = {}) {
        return {
          request_session: analysis?.requestSession || fallback.request_session || null,
          title: analysis?.title || fallback.title || 'AI Auto Audit',
          provider: analysis?.provider || fallback.provider || state.analysisForm.provider,
          model: analysis?.model || fallback.model || state.analysisForm.model,
          status: 'requested',
          requested_at: analysis?.requestedAt || new Date().toISOString(),
          completed_at: null,
          critical: null,
          high: null,
          medium: null,
          report_path: null,
          error: null,
        };
      }

      function markContractPendingAudit(contractAddress, analysis) {
        const normalized = String(contractAddress || '').toLowerCase();
        if (!normalized) return;

        if (Array.isArray(state.dashboard.contracts)) {
          state.dashboard.contracts = state.dashboard.contracts.map((row) => (
            String(row?.contract || '').toLowerCase() === normalized
              ? {
                ...row,
                auto_audit_status: 'processing',
                auto_audit_critical: null,
                auto_audit_high: null,
                auto_audit_medium: null,
              }
              : row
          ));
        }

        if (Array.isArray(state.prepared.dashboardContracts)) {
          state.prepared.dashboardContracts = state.prepared.dashboardContracts.map((row) => (
            String(row?.contract || '').toLowerCase() === normalized
              ? {
                ...row,
                auto_audit_status: 'processing',
                auto_audit_critical: null,
                auto_audit_high: null,
                auto_audit_medium: null,
              }
              : row
          ));
        }

        if (state.tokenDetail?.groups?.length) {
          const nextGroups = state.tokenDetail.groups.map((group) => ({
            ...group,
            contracts: (group.contracts || []).map((row) => (
              String(row?.contract || '').toLowerCase() === normalized
                ? {
                  ...row,
                  auto_audit_status: 'processing',
                  auto_audit_critical: null,
                  auto_audit_high: null,
                  auto_audit_medium: null,
                }
                : row
            )),
          }));
          state.tokenDetail = { ...state.tokenDetail, groups: nextGroups };
          state.prepared.tokenDetail = prepareTokenDetail(state.tokenDetail);
        }

        if (String(state.contractDetail?.address || '').toLowerCase() === normalized) {
          state.contractDetail = {
            ...state.contractDetail,
            auto_analysis: buildPendingAutoAnalysis(analysis, state.contractDetail?.auto_analysis),
          };
        }
      }

      function markTokenPendingAudit(tokenAddress, analysis) {
        const normalized = String(tokenAddress || '').toLowerCase();
        if (!normalized) return;

        if (Array.isArray(state.dashboard.tokens)) {
          state.dashboard.tokens = state.dashboard.tokens.map((row) => (
            String(row?.token || '').toLowerCase() === normalized
              ? {
                ...row,
                auto_audit_status: 'processing',
                auto_audit_critical: null,
                auto_audit_high: null,
                auto_audit_medium: null,
              }
              : row
          ));
        }

        if (Array.isArray(state.prepared.dashboardTokens)) {
          state.prepared.dashboardTokens = state.prepared.dashboardTokens.map((row) => (
            String(row?.token || '').toLowerCase() === normalized
              ? {
                ...row,
                auto_audit_status: 'processing',
                auto_audit_critical: null,
                auto_audit_high: null,
                auto_audit_medium: null,
              }
              : row
          ));
        }

        if (String(state.tokenDetail?.token || '').toLowerCase() === normalized) {
          state.tokenDetail = {
            ...state.tokenDetail,
            auto_analysis: buildPendingAutoAnalysis(analysis, state.tokenDetail?.auto_analysis),
          };
        }
      }

      function canRequestOverviewAutoAudit(row) {
        const status = autoAuditStatusLabel(row?.auto_audit_status);
        return status !== 'processing';
      }

      function canRequestTokenAutoAudit(row) {
        const status = autoAuditStatusLabel(row?.auto_audit_status);
        return status !== 'processing';
      }

      async function requestOverviewAutoAudit(row) {
        if (!row?.contract || !canRequestOverviewAutoAudit(row)) return;
        try {
          const data = await apiFetch('/api/contract-analysis/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: state.selectedChain,
              contract: row.contract,
            }),
          });
          markContractPendingAudit(row.contract, data.analysis);
          invalidateChainCache(state.selectedChain);
          await loadDashboardContracts({ showLoading: false, force: true });
          if (state.contractDetail?.address === row.contract) {
            await loadContractDetail({ force: true });
          }
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }

      async function requestTokenAutoAudit(row) {
        if (!row?.token || !canRequestTokenAutoAudit(row)) return;
        try {
          const data = await apiFetch('/api/token-analysis/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: state.selectedChain,
              token: row.token,
            }),
          });
          markTokenPendingAudit(row.token, data.analysis);
          invalidateChainCache(state.selectedChain);
          await loadDashboardTokens({ showLoading: false, force: true });
          if (state.tokenDetail?.token === row.token) {
            await loadTokenDetail({ force: true });
          }
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }

      async function requestContractAnalysis() {
        if (!state.contractDetail?.address || !canRequestContractAnalysis()) return;
        try {
          const data = await apiFetch('/api/contract-analysis/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: state.selectedChain,
              contract: state.contractDetail.address,
              title: state.analysisForm.title,
              provider: state.analysisForm.provider,
              model: state.analysisForm.model,
            }),
          });
          markContractPendingAudit(state.contractDetail.address, data.analysis);
          invalidateChainCache(state.selectedChain);
          await loadContractDetail({ force: true });
          window.alert('AI analysis requested');
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }

      async function requestTokenAnalysis() {
        if (!state.tokenDetail?.token || !canRequestTokenAnalysis()) return;
        try {
          const data = await apiFetch('/api/token-analysis/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: state.selectedChain,
              token: state.tokenDetail.token,
              title: state.analysisForm.title,
              provider: state.analysisForm.provider,
              model: state.analysisForm.model,
            }),
          });
          markTokenPendingAudit(state.tokenDetail.token, data.analysis);
          invalidateChainCache(state.selectedChain);
          await loadTokenDetail({ force: true });
          window.alert('AI analysis requested');
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }

      function openAiReport() {
        if (!state.contractDetail?.address || !contractAiAnalysis.value?.report_path) return;
        const targetUrl = `/api/contract-analysis/report?chain=${encodeURIComponent(state.selectedChain || '')}&contract=${encodeURIComponent(state.contractDetail.address)}`;
        window.open(targetUrl, '_blank', 'noopener');
      }

      function openTokenAiReport() {
        if (!state.tokenDetail?.token || !tokenAiAnalysis.value?.report_path) return;
        const targetUrl = `/api/token-analysis/report?chain=${encodeURIComponent(state.selectedChain || '')}&token=${encodeURIComponent(state.tokenDetail.token)}`;
        window.open(targetUrl, '_blank', 'noopener');
      }

      function addAiProviderRow() {
        const nextIndex = (state.settings.ai_providers || []).length;
        state.settings.ai_providers.push({
          provider: '',
          enabled: true,
          position: nextIndex,
        });
      }

      function removeAiProviderRow(index) {
        const row = state.settings.ai_providers[index];
        if (!row) return;
        const provider = String(row.provider || '').trim().toLowerCase();
        state.settings.ai_providers.splice(index, 1);
        if (provider) {
          state.settings.ai_models = state.settings.ai_models.filter((model) => String(model.provider || '').trim().toLowerCase() !== provider);
        }
      }

      function addAiModelRow() {
        const provider = normalizeAiProvider(state.analysisForm.provider);
        state.settings.ai_models.push({
          id: Date.now(),
          provider,
          model: '',
          enabled: true,
          is_default: false,
          position: (state.settings.ai_models || []).filter((row) => String(row.provider || '').trim().toLowerCase() === provider).length,
        });
      }

      function removeAiModelRow(index) {
        state.settings.ai_models.splice(index, 1);
      }

      function addWhitelistPatternRow() {
        state.settings.whitelist_patterns.push({
          id: Date.now(),
          name: '',
          hex_pattern: '',
          pattern_type: 'selector',
          score: 1,
          description: '',
        });
      }

      function removeWhitelistPatternRow(index) {
        state.settings.whitelist_patterns.splice(index, 1);
      }

      async function saveSettings() {
        const aiProviders = (state.settings.ai_providers || [])
          .map((row, index) => ({
            provider: String(row.provider || '').trim().toLowerCase(),
            enabled: row.enabled !== false,
            position: Number.isFinite(Number(row.position)) ? Number(row.position) : index,
          }))
          .filter((row) => row.provider);

        const aiModels = (state.settings.ai_models || [])
          .map((row, index) => ({
            provider: String(row.provider || '').trim().toLowerCase(),
            model: String(row.model || '').trim(),
            enabled: row.enabled !== false,
            is_default: Boolean(row.is_default),
            position: Number.isFinite(Number(row.position)) ? Number(row.position) : index,
          }))
          .filter((row) => row.provider && row.model);

        const whitelistPatterns = (state.settings.whitelist_patterns || [])
          .map((row, index) => ({
            name: String(row.name || '').trim(),
            hex_pattern: String(row.hex_pattern || '').trim().toLowerCase().replace(/^0x/, ''),
            pattern_type: String(row.pattern_type || 'selector').trim().toLowerCase() || 'selector',
            score: Number.isFinite(Number(row.score)) ? Number(row.score) : (index + 1),
            description: String(row.description || '').trim(),
          }))
          .filter((row) => row.name && row.hex_pattern);

        try {
          state.settings.runtime_settings.auto_analysis.provider = normalizeAiProvider(state.settings.runtime_settings.auto_analysis.provider);
          state.settings.runtime_settings.auto_analysis.model = normalizeAiModel(
            state.settings.runtime_settings.auto_analysis.provider,
            state.settings.runtime_settings.auto_analysis.model,
          );
          const data = await apiFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runtime_settings: state.settings.runtime_settings,
              chain_configs: state.settings.chain_configs,
              ai_providers: aiProviders,
              ai_models: aiModels,
              whitelist_patterns: whitelistPatterns,
            }),
          });
          state.settings.runtime_settings = data.settings?.runtime_settings || state.settings.runtime_settings;
          state.settings.runtime_settings = {
            ...state.settings.runtime_settings,
            ...(data.settings?.runtime_settings || {}),
            chainbase_keys: Array.isArray(data.settings?.runtime_settings?.chainbase_keys)
              ? data.settings.runtime_settings.chainbase_keys.join('\n')
              : String(data.settings?.runtime_settings?.chainbase_keys || state.settings.runtime_settings.chainbase_keys || ''),
            rpc_keys: Array.isArray(data.settings?.runtime_settings?.rpc_keys)
              ? data.settings.runtime_settings.rpc_keys.join('\n')
              : String(data.settings?.runtime_settings?.rpc_keys || state.settings.runtime_settings.rpc_keys || ''),
          };
          state.settings.runtime_settings.auto_analysis.provider = normalizeAiProvider(state.settings.runtime_settings.auto_analysis.provider);
          state.settings.runtime_settings.auto_analysis.model = normalizeAiModel(
            state.settings.runtime_settings.auto_analysis.provider,
            state.settings.runtime_settings.auto_analysis.model,
          );
          state.settings.chain_configs = data.settings?.chain_configs || state.settings.chain_configs;
          state.settings.ai_providers = data.settings?.ai_providers || aiProviders;
          state.settings.ai_models = data.settings?.ai_models || aiModels;
          state.settings.whitelist_patterns = data.settings?.whitelist_patterns || whitelistPatterns;
          viewDataCache.settings = data.settings || data;
          state.analysisForm.provider = normalizeAiProvider(state.analysisForm.provider);
          state.analysisForm.model = normalizeAiModel(state.analysisForm.provider, state.analysisForm.model);
          window.alert('Settings saved and hot-applied');
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }

      async function saveReview() {
        if (!state.contractDetail?.address) return;
        if (!state.reviewForm.label.trim()) {
          window.alert('Label is required');
          return;
        }
        try {
          await apiFetch('/api/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: state.selectedChain,
              address: state.contractDetail.address,
              target_kind: state.reviewForm.target_kind,
              label: state.reviewForm.label,
              review_text: state.reviewForm.review_text,
              exploitable: state.reviewForm.exploitable,
            }),
          });
          state.reviewForm.review_text = '';
          invalidateChainCache(state.selectedChain);
          await loadContractDetail({ force: true });
          window.alert('Review saved');
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }

      async function saveTokenReview() {
        if (!state.tokenDetail?.token) return;
        try {
          await apiFetch('/api/token-review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chain: state.selectedChain,
              token: state.tokenDetail.token,
              review_text: state.tokenReviewForm.review_text,
              exploitable: state.tokenReviewForm.exploitable,
            }),
          });
          invalidateChainCache(state.selectedChain);
          await loadTokenDetail({ force: true });
          state.tokenReviewExpanded = false;
          window.alert('Token review saved');
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }

      async function logout() {
        try {
          await fetch('/api/logout', { method: 'POST' });
        } finally {
          window.location.assign('/login');
        }
      }

      onMounted(async () => {
        try {
          await router.isReady();
          syncStateFromRoute();
          await Promise.race([
            startStateStream(),
            new Promise((resolve) => window.setTimeout(resolve, 1200)),
          ]);
          if (!state.chains.length) {
            const data = await apiFetch('/api/state');
            await applyStatePayload(data);
          }
          if (currentView.value === 'dashboard' && (state.dashboardTab === 'settings' || state.dashboardTab === 'auto')) {
            await loadSettings({ showLoading: false });
          }
          await loadViewDataForCurrentRoute();
          await restoreCurrentScroll();
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }

        window.addEventListener('scroll', persistCurrentScroll, { passive: true });
        window.addEventListener('beforeunload', persistCurrentScroll);
      });

      router.beforeEach((to, from, next) => {
        persistScrollForRoute(from);
        next();
      });

      watch(
        () => router.currentRoute.value.fullPath,
        async () => {
          syncStateFromRoute();
          await loadViewDataForCurrentRoute();
          await restoreCurrentScroll();
          if (pendingExplicitRestoreKey && pendingExplicitRestoreKey === currentRelativeRoute()) {
            if (pendingExplicitRestorePosition > 0) {
              restoreScrollPosition(pendingExplicitRestorePosition);
            }
            pendingExplicitRestoreKey = '';
            pendingExplicitRestorePosition = 0;
          }
        },
      );

      watch(
        () => [
          currentView.value,
          state.selectedChain,
          state.dashboardTab,
          state.settingsSection,
        ],
        () => {
          syncDashboardUrlState();
          syncTokenUrlState();
        },
      );

      watch(
        () => ({
          tokenQuery: state.dashboardFilters.tokenQuery,
          contractQuery: state.dashboardFilters.contractQuery,
          contractRisk: state.dashboardFilters.contractRisk,
          contractLinkType: state.dashboardFilters.contractLinkType,
        }),
        (filters) => {
          persistStoredFilters(filters);
          if (currentView.value === 'token') {
            resetTablePage('tokenDirectory');
            scheduleCollectionReload('tokens');
          }
          if (currentView.value === 'dashboard' && state.dashboardTab === 'tokens') {
            resetTablePage('contractOverview');
            scheduleCollectionReload('contracts');
          }
        },
        { deep: true },
      );

      watch(
        () => ({
          key: state.tableSorts.contractOverview.key,
          dir: state.tableSorts.contractOverview.dir,
          page: state.tablePages.contractOverview,
        }),
        () => {
          if (currentView.value === 'dashboard' && state.dashboardTab === 'tokens') {
            scheduleCollectionReload('contracts');
          }
        },
        { deep: true },
      );

      watch(
        () => ({
          key: state.tableSorts.tokenDirectory.key,
          dir: state.tableSorts.tokenDirectory.dir,
          page: state.tablePages.tokenDirectory,
        }),
        () => {
          if (currentView.value === 'token') {
            scheduleCollectionReload('tokens');
          }
        },
        { deep: true },
      );

      watch(
        () => routeToken.value,
        () => {
          resetTablePage('tokenRelatedContracts');
        },
      );

      watch(
        () => routeContract.value,
        () => {
        },
      );

      watch(
        () => state.selectedContractFlowToken,
        () => {
        },
      );

      watch(
        () => state.analysisForm.provider,
        (provider) => {
          const normalizedProvider = normalizeAiProvider(provider);
          if (state.analysisForm.provider !== normalizedProvider) {
            state.analysisForm.provider = normalizedProvider;
            return;
          }
          const normalizedModel = normalizeAiModel(normalizedProvider, state.analysisForm.model);
          if (state.analysisForm.model !== normalizedModel) {
            state.analysisForm.model = normalizedModel;
          }
        },
        { immediate: true },
      );

      watch(
        () => state.settings.runtime_settings.auto_analysis.provider,
        (provider) => {
          const normalizedProvider = normalizeAiProvider(provider);
          if (state.settings.runtime_settings.auto_analysis.provider !== normalizedProvider) {
            state.settings.runtime_settings.auto_analysis.provider = normalizedProvider;
            return;
          }
          const normalizedModel = normalizeAiModel(
            normalizedProvider,
            state.settings.runtime_settings.auto_analysis.model,
          );
          if (state.settings.runtime_settings.auto_analysis.model !== normalizedModel) {
            state.settings.runtime_settings.auto_analysis.model = normalizedModel;
          }
        },
        { immediate: true },
      );

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
        filteredTokens,
        paginatedFilteredTokens,
        filteredContracts,
        paginatedFilteredContracts,
        contractOverviewSections,
        tokenContracts,
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
