(() => {
  function createDashboardActions(deps) {
    const {
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
      prepareDashboardContractRows,
      prepareDashboardTokenRows,
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
      ignoreNextReviewUpdate,
    } = deps;

    let copiedAddressTimer = null;

    function upsertContractReview(reviews, nextReview) {
      const rows = Array.isArray(reviews) ? reviews.slice() : [];
      const index = rows.findIndex((entry) => {
        if (nextReview.pattern_hash && entry.pattern_hash === nextReview.pattern_hash) return true;
        return entry.pattern_kind === nextReview.pattern_kind
          && entry.pattern_address === nextReview.pattern_address;
      });
      if (index >= 0) {
        rows[index] = {
          ...rows[index],
          ...nextReview,
          id: rows[index].id ?? nextReview.id,
        };
        return { rows, inserted: false };
      }
      return { rows: [nextReview, ...rows], inserted: true };
    }

    function refreshPreparedContracts() {
      state.prepared.dashboardContracts = prepareDashboardContractRows(state.dashboard.contracts || []);
    }

    function refreshPreparedTokens() {
      state.prepared.dashboardTokens = prepareDashboardTokenRows(state.dashboard.tokens || []);
    }

    function applyLocalContractReviewUpdate(input) {
      const address = String(input.address || '').toLowerCase();
      if (!address) return;

      const targetKind = String(input.targetKind || 'contract').toLowerCase();
      const target = (state.contractDetail?.pattern_targets || []).find((entry) => entry.kind === targetKind)
        || { kind: targetKind, address, pattern_hash: input.hash || '' };
      const nextReview = {
        id: `local-${Date.now()}`,
        chain: String(state.selectedChain || '').toLowerCase(),
        contract_address: address,
        pattern_hash: String(input.hash || target.pattern_hash || '').toLowerCase(),
        pattern_kind: String(target.kind || targetKind || 'contract').toLowerCase(),
        pattern_address: String(target.address || address).toLowerCase(),
        label: String(input.label || '').trim(),
        review_text: String(input.reviewText || ''),
        exploitable: Boolean(input.exploitable),
        status: 'saved',
        updated_at: new Date().toISOString(),
      };

      let insertedReview = false;
      if (state.contractDetail?.address && String(state.contractDetail.address).toLowerCase() === address) {
        if (input.persistedOnly) {
          state.contractDetail = {
            ...state.contractDetail,
            label: nextReview.label || state.contractDetail.label,
            review: nextReview.review_text,
            is_exploitable: nextReview.exploitable,
            is_manual_audit: true,
          };
        } else {
          const reviewResult = upsertContractReview(state.contractDetail.reviews, nextReview);
          insertedReview = reviewResult.inserted;
          state.contractDetail = {
            ...state.contractDetail,
            label: nextReview.label || state.contractDetail.label,
            is_exploitable: nextReview.exploitable,
            is_manual_audit: true,
            reviews: reviewResult.rows,
          };
        }
      }

      if (state.tokenDetail?.groups?.length) {
        state.tokenDetail = {
          ...state.tokenDetail,
          groups: state.tokenDetail.groups.map((group) => ({
            ...group,
            contracts: (group.contracts || []).map((contract) => {
              if (String(contract?.contract || '').toLowerCase() !== address) return contract;
              const reviewResult = input.persistedOnly
                ? { rows: contract.reviews || [], inserted: false }
                : upsertContractReview(contract.reviews, nextReview);
              return {
                ...contract,
                label: nextReview.label || contract.label,
                is_exploitable: nextReview.exploitable,
                is_manual_audit: true,
                ...(input.persistedOnly
                  ? { review: nextReview.review_text }
                  : { reviews: reviewResult.rows }),
              };
            }),
          })),
        };
        state.prepared.tokenDetail = prepareTokenDetail(state.tokenDetail);
      }

      if (Array.isArray(state.dashboard.contracts) && state.dashboard.contracts.length) {
        state.dashboard.contracts = state.dashboard.contracts.map((row) => {
          if (String(row?.contract || '').toLowerCase() !== address) return row;
          const existingReviewCount = Number(row.review_count || 0);
          return {
            ...row,
            label: nextReview.label || row.label,
            is_exploitable: nextReview.exploitable,
            is_manual_audit: true,
            review_count: input.persistedOnly
              ? existingReviewCount
              : existingReviewCount + (insertedReview ? 1 : 0),
          };
        });
        refreshPreparedContracts();
      }
    }

    function applyLocalTokenReviewUpdate(input) {
      const tokenAddress = String(input.token || '').toLowerCase();
      if (!tokenAddress) return;

      if (state.tokenDetail?.token && String(state.tokenDetail.token).toLowerCase() === tokenAddress) {
        state.tokenDetail = {
          ...state.tokenDetail,
          review: String(input.reviewText || ''),
          is_exploitable: Boolean(input.exploitable),
          is_manual_audit: true,
        };
        state.prepared.tokenDetail = prepareTokenDetail(state.tokenDetail);
      }

      if (Array.isArray(state.dashboard.tokens) && state.dashboard.tokens.length) {
        state.dashboard.tokens = state.dashboard.tokens.map((row) => (
          String(row?.token || '').toLowerCase() === tokenAddress
            ? {
              ...row,
              review: String(input.reviewText || ''),
              is_exploitable: Boolean(input.exploitable),
              is_manual_audit: true,
            }
            : row
        ));
        refreshPreparedTokens();
      }
    }

    async function handleChainChanged() {
      loaders.clearChainScopedData();
      if (currentView.value === 'dashboard') {
        await updateUrl('/', dashboardUrlParams());
        if (state.dashboardTab === 'settings' || state.dashboardTab === 'auto') {
          await loaders.loadSettings();
          return;
        }
        await loaders.refreshCurrent();
        return;
      }
      if (currentView.value === 'token') {
        await updateUrl('/token', {
          chain: state.selectedChain,
        });
        await loaders.loadDashboardTokens();
        return;
      }
      if (currentView.value === 'token-detail') {
        await updateUrl('/token-detail', { chain: state.selectedChain, token: state.route.token });
        await loaders.refreshCurrent();
        return;
      }
      await updateUrl('/contract', { chain: state.selectedChain, contract: state.route.contract });
      await loaders.refreshCurrent();
    }

    async function runScan() {
      if (!state.isAdmin) {
        pushNotification('Run Round is available to admin users only', 'warning', 4200);
        return;
      }
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
        await loaders.refreshCurrent();
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
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
            body: JSON.stringify({
              chain: state.selectedChain,
              config: state.settings.runtime_settings.auto_analysis,
            }),
          });
        state.autoAnalysis = data.status || state.autoAnalysis;
        pushNotification(
          autoAnalysisEnabled.value ? 'Auto analysis stopped' : 'Auto analysis started',
          'success',
        );
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
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
      state.settingsSection = state.isAdmin ? section : 'account';
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
        await loaders.loadDashboardContracts({ showLoading: false, force: true });
        if (state.contractDetail?.address === row.contract) {
          await loaders.loadContractDetail({ force: true });
        }
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
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
        await loaders.loadDashboardTokens({ showLoading: false, force: true });
        if (state.tokenDetail?.token === row.token) {
          await loaders.loadTokenDetail({ force: true });
        }
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
      }
    }

    async function requestContractAnalysis() {
      if (!state.contractDetail?.address || String(contractAiAnalysis.value?.status || '') === 'requested' || String(contractAiAnalysis.value?.status || '') === 'running') return;
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
        await loaders.loadContractDetail({ force: true });
        pushNotification('AI analysis requested', 'success');
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
      }
    }

    async function requestTokenAnalysis() {
      if (!state.tokenDetail?.token || String(tokenAiAnalysis.value?.status || '') === 'requested' || String(tokenAiAnalysis.value?.status || '') === 'running') return;
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
        await loaders.loadTokenDetail({ force: true });
        pushNotification('AI analysis requested', 'success');
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
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
      if (!state.isAdmin) {
        await saveAccountSettings();
        return;
      }
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
        const autoAnalysisDraft = {
          ...state.settings.runtime_settings.auto_analysis,
        };
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
        applySettingsPayload({
          ...data.settings,
          ai_providers: data.settings?.ai_providers || aiProviders,
          ai_models: data.settings?.ai_models || aiModels,
          whitelist_patterns: data.settings?.whitelist_patterns || whitelistPatterns,
        });
        state.settings.runtime_settings.auto_analysis = {
          ...state.settings.runtime_settings.auto_analysis,
          ...autoAnalysisDraft,
        };
        state.settings.runtime_settings.auto_analysis.provider = normalizeAiProvider(state.settings.runtime_settings.auto_analysis.provider);
        state.settings.runtime_settings.auto_analysis.model = normalizeAiModel(
          state.settings.runtime_settings.auto_analysis.provider,
          state.settings.runtime_settings.auto_analysis.model,
        );
        viewDataCache.settings = {
          payload: data.settings || data,
          cachedAt: Date.now(),
        };
        pushNotification('Settings saved and hot-applied', 'success');
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
      }
    }

    async function saveAccountSettings() {
      const account = state.settings.runtime_settings.account || {};
      try {
        const data = await apiFetch('/api/account', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: String(account.username || '').trim(),
            ai_api_key: String(account.ai_api_key || '').trim(),
            current_password: String(account.current_password || ''),
            new_password: String(account.new_password || ''),
            confirm_password: String(account.confirm_password || ''),
          }),
        });
        state.settings.runtime_settings.account = {
          ...(state.settings.runtime_settings.account || {}),
          ...(data.account || {}),
          current_password: '',
          new_password: '',
          confirm_password: '',
        };
        if (data.account?.username) {
          state.currentUser = data.account.username;
        }
        if (data.account?.role) {
          state.currentUserRole = data.account.role;
          state.isAdmin = data.account.role === 'admin';
        }
        viewDataCache.settings = null;
        pushNotification('Account saved', 'success');
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
      }
    }

    async function saveReview() {
      if (!state.contractDetail?.address) return;
      if (!state.reviewForm.label.trim()) {
        pushNotification('Label is required', 'warning', 3600);
        return;
      }
      try {
        const data = await apiFetch('/api/review', {
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
        ignoreNextReviewUpdate(state.selectedChain, 'contract', state.contractDetail.address);
        applyLocalContractReviewUpdate({
          address: state.contractDetail.address,
          targetKind: state.reviewForm.target_kind,
          label: state.reviewForm.label,
          reviewText: state.reviewForm.review_text,
          exploitable: state.reviewForm.exploitable,
          hash: data?.hash || '',
          persistedOnly: Boolean(data?.persisted_only),
        });
        invalidateChainCache(state.selectedChain);
        pushNotification('Review saved', 'success');
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
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
        ignoreNextReviewUpdate(state.selectedChain, 'token', state.tokenDetail.token);
        applyLocalTokenReviewUpdate({
          token: state.tokenDetail.token,
          reviewText: state.tokenReviewForm.review_text,
          exploitable: state.tokenReviewForm.exploitable,
        });
        invalidateChainCache(state.selectedChain);
        state.tokenReviewExpanded = false;
        pushNotification('Token review saved', 'success');
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
      }
    }

    async function logout() {
      try {
        await fetch('/api/logout', { method: 'POST' });
      } finally {
        window.location.assign('/login');
      }
    }

    return {
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
      goBackToPrevious,
      copyAddress,
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
      saveAccountSettings,
      saveReview,
      saveTokenReview,
      logout,
    };
  }

  window.EventFilterDashboardActions = {
    createDashboardActions,
  };
})();
