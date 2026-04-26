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
    let autoAnalysisRatioDrag = null;

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

    function openRunRoundModal() {
      Object.assign(state.runRoundModal, {
        open: true,
        chain: String(state.selectedChain || state.runRoundModal?.chain || state.chains?.[0] || '').trim().toLowerCase(),
        fromBlock: String(state.runRange?.fromBlock || ''),
        toBlock: String(state.runRange?.toBlock || ''),
        deltaBlocks: String(state.runRange?.deltaBlocks || ''),
        error: '',
      });
    }

    function closeRunRoundModal() {
      Object.assign(state.runRoundModal, {
        open: false,
        error: '',
      });
    }

    async function runScan(input = null) {
      const requestedChain = String(input?.chain || state.selectedChain || '').trim().toLowerCase();
      if (!requestedChain || state.running) return false;
      const rawFromBlock = String(input?.fromBlock ?? state.runRange?.fromBlock ?? '').trim();
      const rawToBlock = String(input?.toBlock ?? state.runRange?.toBlock ?? '').trim();
      const rawDeltaBlocks = String(input?.deltaBlocks ?? state.runRange?.deltaBlocks ?? '').trim();
      const parseBlockInput = (label, value) => {
        if (!value) return undefined;
        if (!/^\d+$/.test(value)) {
          throw new Error(`${label} block must be a non-negative integer`);
        }
        return Number(value);
      };
      const parseDeltaInput = (value) => {
        if (!value) return undefined;
        if (!/^\d+$/.test(value)) {
          throw new Error('Delta blocks must be a positive integer');
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('Delta blocks must be a positive integer');
        }
        return parsed;
      };

      let fromBlock;
      let toBlock;
      let deltaBlocks;
      try {
        fromBlock = parseBlockInput('From', rawFromBlock);
        toBlock = parseBlockInput('To', rawToBlock);
        deltaBlocks = parseDeltaInput(rawDeltaBlocks);
        if (fromBlock != null && toBlock != null && toBlock <= fromBlock) {
          throw new Error('To block must be greater than From block');
        }
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 4200);
        return;
      }

      Object.assign(state.runRange, {
        fromBlock: rawFromBlock,
        toBlock: rawToBlock,
        deltaBlocks: rawDeltaBlocks,
      });
      state.running = true;
      state.runningChain = requestedChain;
      state.progress = {
        chain: requestedChain,
        stage: 'boot',
        label: 'Starting pipeline round',
        percent: 1,
        updated_at: new Date().toISOString(),
      };
      try {
        await apiFetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chain: requestedChain,
            ...(fromBlock != null ? { fromBlock } : {}),
            ...(toBlock != null ? { toBlock } : {}),
            ...(deltaBlocks != null ? { deltaBlocks } : {}),
          }),
        });
        const chainChanged = requestedChain !== state.selectedChain;
        if (chainChanged) {
          state.selectedChain = requestedChain;
          await handleChainChanged();
        } else {
          await loaders.refreshCurrent();
        }
        return true;
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
        return false;
      } finally {
        state.running = false;
      }
    }

    async function confirmRunRoundModal() {
      const targetChain = String(state.runRoundModal?.chain || '').trim().toLowerCase();
      if (!targetChain) {
        state.runRoundModal.error = 'Chain is required';
        return;
      }
      state.runRoundModal.error = '';
      const didRun = await runScan({
        chain: targetChain,
        fromBlock: state.runRoundModal.fromBlock,
        toBlock: state.runRoundModal.toBlock,
        deltaBlocks: state.runRoundModal.deltaBlocks,
      });
      if (didRun) {
        closeRunRoundModal();
      }
    }

    async function syncTokenPrices() {
      if (state.syncingPrices) return;
      state.syncingPrices = true;
      try {
        const data = await apiFetch('/api/token-prices/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const syncedChains = Array.isArray(data?.chains) ? data.chains : [];
        syncedChains.forEach((entry) => invalidateChainCache(entry?.chain || ''));
        await loaders.refreshCurrent({ force: true });
        pushNotification(
          `Synced ${Number(data?.updated_tokens) || 0}/${Number(data?.total_tokens) || 0} token prices across ${syncedChains.length} chain(s)`,
          'success',
          4200,
        );
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
      } finally {
        state.syncingPrices = false;
      }
    }

    async function toggleAutoAnalysis() {
      const wasEnabled = autoAnalysisEnabled.value;
      const selectedAutoChains = Array.isArray(state.settings.runtime_settings.auto_analysis?.selected_chains)
        ? state.settings.runtime_settings.auto_analysis.selected_chains
        : [];
      if (!selectedAutoChains.length && !wasEnabled) return;
      const autoRange = state.settings.runtime_settings.auto_analysis || {};
      const parseOptionalBlock = (label, value) => {
        const normalized = String(value ?? '').trim();
        if (!normalized) return undefined;
        if (!/^\d+$/.test(normalized)) {
          throw new Error(`Auto ${label} block must be a non-negative integer`);
        }
        return Number(normalized);
      };
      try {
        if (!wasEnabled) {
          const chainConfigs = autoRange.chain_configs && typeof autoRange.chain_configs === 'object'
            ? autoRange.chain_configs
            : {};
          for (const chain of selectedAutoChains) {
            const chainConfig = chainConfigs[chain] && typeof chainConfigs[chain] === 'object'
              ? chainConfigs[chain]
              : {};
            const fromBlock = parseOptionalBlock(`${String(chain).toUpperCase()} From`, chainConfig.from_block);
            const toBlock = parseOptionalBlock(`${String(chain).toUpperCase()} To`, chainConfig.to_block);
            const deltaBlocks = parseOptionalBlock(`${String(chain).toUpperCase()} Delta`, chainConfig.delta_blocks);
            if (fromBlock != null && toBlock != null && toBlock <= fromBlock) {
              throw new Error(`${String(chain).toUpperCase()} To block must be greater than From block`);
            }
            if (deltaBlocks != null && deltaBlocks <= 0) {
              throw new Error(`${String(chain).toUpperCase()} Delta blocks must be a positive integer`);
            }
          }
        }
        const data = wasEnabled
          ? await apiFetch('/api/auto-analysis/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
          : await apiFetch('/api/auto-analysis/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              config: state.settings.runtime_settings.auto_analysis,
            }),
          });
        state.autoAnalysis = data.status || state.autoAnalysis;
        pushNotification(
          wasEnabled ? 'Auto analysis stopped' : 'Auto analysis started',
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

    async function openDashboardMain() {
      state.dashboardTab = 'dashboard';
      if (currentView.value === 'dashboard') {
        syncDashboardUrlState();
        await loaders.loadDashboard({ force: true });
        return;
      }
      navigateDashboard();
    }

    function openContractsMain() {
      state.dashboardTab = 'contracts';
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

    function closeAuditReportDrawer() {
      Object.assign(state.auditReportDrawer, {
        open: false,
        loading: false,
        targetType: 'contract',
        targetAddr: '',
        title: '',
        chain: '',
        reportPath: '',
        content: '',
        error: '',
      });
    }

    async function openAuditResultDrawer(targetType, targetAddr, title) {
      const normalizedType = String(targetType || '').trim().toLowerCase() === 'token' ? 'token' : 'contract';
      const normalizedAddr = String(targetAddr || '').trim().toLowerCase();
      const normalizedChain = String(state.selectedChain || '').trim().toLowerCase();
      if (!normalizedChain || !normalizedAddr) return;
      Object.assign(state.auditReportDrawer, {
        open: true,
        loading: true,
        targetType: normalizedType,
        targetAddr: normalizedAddr,
        title: String(title || normalizedAddr).trim(),
        chain: normalizedChain,
        reportPath: '',
        content: '',
        error: '',
      });
      try {
        const queryKey = normalizedType === 'token' ? 'token' : 'contract';
        const data = await apiFetch(
          `/api/${normalizedType}-analysis/report?chain=${encodeURIComponent(normalizedChain)}&${queryKey}=${encodeURIComponent(normalizedAddr)}&format=json`,
        );
        if (
          state.auditReportDrawer.targetType !== normalizedType
          || state.auditReportDrawer.targetAddr !== normalizedAddr
          || state.auditReportDrawer.chain !== normalizedChain
        ) return;
        Object.assign(state.auditReportDrawer, {
          open: true,
          loading: false,
          title: String(data.title || title || normalizedAddr).trim(),
          reportPath: String(data.report_path || '').trim(),
          content: String(data.report_text || ''),
          error: '',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(state.auditReportDrawer, {
          open: true,
          loading: false,
          reportPath: '',
          content: '',
          error: message,
        });
        pushNotification(message, 'error', 4200);
      }
    }

    async function openContractAuditResultDrawer(row) {
      if (autoAuditStatusLabel(row?.auto_audit_status) !== 'yes' || !row?.contract) return;
      const title = row?.label || row?.contract;
      await openAuditResultDrawer('contract', row.contract, title);
    }

    async function openTokenAuditResultDrawer(row) {
      if (autoAuditStatusLabel(row?.auto_audit_status) !== 'yes' || !row?.token) return;
      const title = row?.token_symbol || row?.token_name || row?.token;
      await openAuditResultDrawer('token', row.token, title);
    }

    function buildChainConfigDraft() {
      return {
        chain: '',
        name: '',
        chain_id: '',
        table_prefix: '',
        blocks_per_scan: 75,
        pipeline_source: 'chainbase',
        rpc_network: '',
        multicall3: '',
        wrapped_native_token_address: '',
        native_currency_name: '',
        native_currency_symbol: '',
        native_currency_decimals: 18,
      };
    }

    function normalizeChainConfigPayload(row) {
      return {
        chain: String(row?.chain || '').trim().toLowerCase(),
        name: String(row?.name || '').trim(),
        chain_id: Number.isFinite(Number(row?.chain_id)) ? Number(row.chain_id) : '',
        table_prefix: String(row?.table_prefix || '').trim(),
        blocks_per_scan: Number.isFinite(Number(row?.blocks_per_scan)) ? Number(row.blocks_per_scan) : 75,
        pipeline_source: String(row?.pipeline_source || '').trim().toLowerCase() === 'rpc' ? 'rpc' : 'chainbase',
        rpc_network: String(row?.rpc_network || '').trim(),
        multicall3: String(row?.multicall3 || '').trim().toLowerCase(),
        wrapped_native_token_address: String(row?.wrapped_native_token_address || '').trim().toLowerCase(),
        native_currency_name: String(row?.native_currency_name || '').trim(),
        native_currency_symbol: String(row?.native_currency_symbol || '').trim(),
        native_currency_decimals: Number.isFinite(Number(row?.native_currency_decimals))
          ? Number(row.native_currency_decimals)
          : 18,
      };
    }

    function addChainConfigRow() {
      state.settings.chain_configs.push(buildChainConfigDraft());
    }

    function removeChainConfigRow(index) {
      if (index < 0 || index >= (state.settings.chain_configs || []).length) return;
      state.settings.chain_configs.splice(index, 1);
    }

    function addAccountAllowedChain() {
      const account = state.settings.runtime_settings.account || {};
      const candidate = String(account.allowed_chain_candidate || '').trim().toLowerCase();
      if (!candidate) return;
      const availableChains = Array.isArray(account.available_chains)
        ? account.available_chains.map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean)
        : [];
      if (!availableChains.includes(candidate)) return;
      const nextAllowedChains = [...new Set([...(account.allowed_chains || []), candidate])];
      const nextCandidate = availableChains.find((chain) => !nextAllowedChains.includes(chain)) || '';
      state.settings.runtime_settings.account = {
        ...account,
        allowed_chains: nextAllowedChains,
        allowed_chain_candidate: nextCandidate,
      };
    }

    function addAutoAnalysisChain() {
      const auto = state.settings.runtime_settings.auto_analysis || {};
      const candidate = String(auto.chain_candidate || '').trim().toLowerCase();
      if (!candidate) return;
      const availableChains = Array.isArray(state.chains) && state.chains.length
        ? state.chains.map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean)
        : (Array.isArray(state.settings.runtime_settings.account?.available_chains)
          ? state.settings.runtime_settings.account.available_chains.map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean)
          : []);
      if (!availableChains.includes(candidate)) return;
      const nextSelectedChains = [...new Set([...(auto.selected_chains || []), candidate])];
      state.settings.runtime_settings.auto_analysis = {
        ...auto,
        selected_chains: nextSelectedChains,
        chain_ratios: {
          ...(auto.chain_ratios || {}),
          [candidate]: Number.isFinite(Number(auto.chain_ratios?.[candidate])) && Number(auto.chain_ratios[candidate]) > 0
            ? Math.max(1, Math.floor(Number(auto.chain_ratios[candidate])))
            : 100,
        },
        chain_configs: {
          ...(auto.chain_configs || {}),
          [candidate]: {
            from_block: String(auto.chain_configs?.[candidate]?.from_block || '').trim(),
            to_block: String(auto.chain_configs?.[candidate]?.to_block || '').trim(),
            delta_blocks: String(auto.chain_configs?.[candidate]?.delta_blocks || '').trim(),
            token_share_percent: Number.isFinite(Number(auto.chain_configs?.[candidate]?.token_share_percent))
              ? Math.max(0, Math.min(100, Math.floor(Number(auto.chain_configs[candidate].token_share_percent))))
              : 40,
            contract_share_percent: Number.isFinite(Number(auto.chain_configs?.[candidate]?.contract_share_percent))
              ? Math.max(0, Math.min(100, Math.floor(Number(auto.chain_configs[candidate].contract_share_percent))))
              : 60,
          },
        },
        chain_candidate: availableChains.find((chain) => !nextSelectedChains.includes(chain)) || '',
      };
    }

    function removeAccountAllowedChain(chain) {
      const account = state.settings.runtime_settings.account || {};
      const normalized = String(chain || '').trim().toLowerCase();
      const nextAllowedChains = (account.allowed_chains || []).filter((entry) => String(entry || '').trim().toLowerCase() !== normalized);
      const availableChains = Array.isArray(account.available_chains)
        ? account.available_chains.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const nextCandidate = account.allowed_chain_candidate
        || availableChains.find((entry) => !nextAllowedChains.includes(entry))
        || '';
      state.settings.runtime_settings.account = {
        ...account,
        allowed_chains: nextAllowedChains,
        allowed_chain_candidate: nextCandidate,
      };
    }

    function removeAutoAnalysisChain(chain) {
      const auto = state.settings.runtime_settings.auto_analysis || {};
      const normalized = String(chain || '').trim().toLowerCase();
      const nextSelectedChains = (auto.selected_chains || []).filter((entry) => String(entry || '').trim().toLowerCase() !== normalized);
      const nextChainRatios = { ...(auto.chain_ratios || {}) };
      const nextChainConfigs = { ...(auto.chain_configs || {}) };
      delete nextChainRatios[normalized];
      delete nextChainConfigs[normalized];
      const availableChains = Array.isArray(state.chains) && state.chains.length
        ? state.chains.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
        : (Array.isArray(state.settings.runtime_settings.account?.available_chains)
          ? state.settings.runtime_settings.account.available_chains.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
          : []);
      state.settings.runtime_settings.auto_analysis = {
        ...auto,
        selected_chains: nextSelectedChains,
        chain_ratios: nextChainRatios,
        chain_configs: nextChainConfigs,
        chain_candidate: availableChains.find((entry) => !nextSelectedChains.includes(entry)) || '',
      };
    }

    function beginAutoAnalysisRatioDrag(index, event) {
      const auto = state.settings.runtime_settings.auto_analysis || {};
      const selectedChains = Array.isArray(auto.selected_chains)
        ? auto.selected_chains.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
        : [];
      if (!Number.isInteger(index) || index < 0 || index >= selectedChains.length - 1) return;

      const bar = event?.currentTarget?.closest?.('[data-auto-ratio-bar]');
      if (!bar) return;

      const ratios = selectedChains.map((chain) => {
        const parsed = Number(auto.chain_ratios?.[chain]);
        return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 100;
      });
      const totalWeight = ratios.reduce((sum, value) => sum + value, 0);
      if (!Number.isFinite(totalWeight) || totalWeight <= 1) return;

      const pairWeight = ratios[index] + ratios[index + 1];
      const beforeWeight = ratios.slice(0, index).reduce((sum, value) => sum + value, 0);
      if (pairWeight <= 1) return;

      const rect = bar.getBoundingClientRect();
      const minWeight = 1;

      const applyPointer = (clientX) => {
        if (!Number.isFinite(clientX) || rect.width <= 0) return;
        const relative = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const boundaryRatio = relative / rect.width;
        const minBoundary = (beforeWeight + minWeight) / totalWeight;
        const maxBoundary = (beforeWeight + pairWeight - minWeight) / totalWeight;
        const clampedBoundary = Math.max(minBoundary, Math.min(maxBoundary, boundaryRatio));
        const pairLeftRatio = (clampedBoundary - (beforeWeight / totalWeight)) / (pairWeight / totalWeight);
        const nextLeft = Math.max(minWeight, Math.min(pairWeight - minWeight, Math.round(pairWeight * pairLeftRatio)));
        const nextRight = pairWeight - nextLeft;
        const nextRatios = {
          ...(auto.chain_ratios || {}),
          [selectedChains[index]]: nextLeft,
          [selectedChains[index + 1]]: nextRight,
        };
        state.settings.runtime_settings.auto_analysis = {
          ...auto,
          chain_ratios: nextRatios,
        };
      };

      const handleMove = (moveEvent) => {
        moveEvent.preventDefault();
        applyPointer(moveEvent.clientX);
      };

      const finish = () => {
        if (!autoAnalysisRatioDrag) return;
        window.removeEventListener('pointermove', autoAnalysisRatioDrag.handleMove);
        window.removeEventListener('pointerup', autoAnalysisRatioDrag.finish);
        window.removeEventListener('pointercancel', autoAnalysisRatioDrag.finish);
        autoAnalysisRatioDrag = null;
      };

      finish();
      autoAnalysisRatioDrag = { handleMove, finish };
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
      applyPointer(event.clientX);
    }

    function beginAutoAnalysisMixDrag(chain, event) {
      const auto = state.settings.runtime_settings.auto_analysis || {};
      const normalizedChain = String(chain || '').trim().toLowerCase();
      if (!normalizedChain) return;

      const bar = event?.currentTarget?.closest?.('[data-auto-mix-bar]');
      if (!bar) return;

      const rect = bar.getBoundingClientRect();
      const currentConfig = auto.chain_configs?.[normalizedChain] || {};

      const applyPointer = (clientX) => {
        if (!Number.isFinite(clientX) || rect.width <= 0) return;
        const relative = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const tokenPercent = Math.max(0, Math.min(100, Math.round((relative / rect.width) * 100)));
        const contractPercent = Math.max(0, 100 - tokenPercent);
        state.settings.runtime_settings.auto_analysis = {
          ...auto,
          chain_configs: {
            ...(auto.chain_configs || {}),
            [normalizedChain]: {
              ...currentConfig,
              token_share_percent: tokenPercent,
              contract_share_percent: contractPercent,
            },
          },
        };
      };

      const handleMove = (moveEvent) => {
        moveEvent.preventDefault();
        applyPointer(moveEvent.clientX);
      };

      const finish = () => {
        if (!autoAnalysisRatioDrag) return;
        window.removeEventListener('pointermove', autoAnalysisRatioDrag.handleMove);
        window.removeEventListener('pointerup', autoAnalysisRatioDrag.finish);
        window.removeEventListener('pointercancel', autoAnalysisRatioDrag.finish);
        autoAnalysisRatioDrag = null;
      };

      finish();
      autoAnalysisRatioDrag = { handleMove, finish };
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
      applyPointer(event.clientX);
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
        description: '',
        created_by_username: String(state.currentUser || state.settings.runtime_settings.account?.username || '').trim().toLowerCase(),
      });
    }

    function removeWhitelistPatternRow(index) {
      state.settings.whitelist_patterns.splice(index, 1);
    }

    async function createManagedUserAccount() {
      const draft = state.settings.runtime_settings.access?.new_user || {};
      try {
        const data = await apiFetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: String(draft.username || '').trim(),
            password: String(draft.password || ''),
            role: String(draft.role || 'user').trim().toLowerCase() || 'user',
          }),
        });
        applySettingsPayload(data.settings || {});
        if (state.settings.runtime_settings.access) {
          state.settings.runtime_settings.access.new_user = {
            username: '',
            password: '',
            role: 'user',
          };
        }
        viewDataCache.settings = null;
        pushNotification('User added', 'success');
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
      }
    }

    async function deleteManagedUserAccount(username) {
      const normalized = String(username || '').trim();
      if (!normalized) return;
      try {
        const data = await apiFetch('/api/admin/users', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: normalized,
          }),
        });
        applySettingsPayload(data.settings || {});
        viewDataCache.settings = null;
        pushNotification('User deleted', 'success');
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 5200);
      }
    }

    async function saveSettings(section = '') {
      const targetSection = String(section || state.settingsSection || '').trim().toLowerCase();
      if (!state.isAdmin && targetSection !== 'whitelist') {
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
        .map((row) => ({
          id: Number.isFinite(Number(row.id)) ? Number(row.id) : undefined,
          name: String(row.name || '').trim(),
          hex_pattern: String(row.hex_pattern || '').trim().toLowerCase().replace(/^0x/, ''),
          pattern_type: String(row.pattern_type || 'selector').trim().toLowerCase() || 'selector',
          description: String(row.description || '').trim(),
          created_by_username: String(row.created_by_username || '').trim().toLowerCase(),
        }))
        .filter((row) => row.name && row.hex_pattern);
      const accessUsers = ((state.settings.runtime_settings.access?.users) || [])
        .map((user) => ({
          username: String(user.username || '').trim(),
          role: String(user.role || 'user').trim().toLowerCase() || 'user',
        }))
        .filter((user) => user.username);
      const chainConfigs = (state.settings.chain_configs || [])
        .map((row) => normalizeChainConfigPayload(row))
        .filter((row) => row.chain);

      try {
        const autoAnalysisDraft = {
          ...state.settings.runtime_settings.auto_analysis,
        };
        state.settings.runtime_settings.auto_analysis.provider = normalizeAiProvider(state.settings.runtime_settings.auto_analysis.provider);
        state.settings.runtime_settings.auto_analysis.model = normalizeAiModel(
          state.settings.runtime_settings.auto_analysis.provider,
          state.settings.runtime_settings.auto_analysis.model,
        );
        const runtimeSettingsPayload = {};
        if (targetSection === 'keys') {
          runtimeSettingsPayload.chainbase_keys = state.settings.runtime_settings.chainbase_keys;
          runtimeSettingsPayload.rpc_keys = state.settings.runtime_settings.rpc_keys;
        }
        if (targetSection === 'access') {
          runtimeSettingsPayload.access = {
            ...(state.settings.runtime_settings.access || {}),
            users: accessUsers,
          };
        }
        if (targetSection === 'pattern-sync') {
          runtimeSettingsPayload.pattern_sync = { ...(state.settings.runtime_settings.pattern_sync || {}) };
        }
        if (targetSection === 'ai') {
          runtimeSettingsPayload.ai_audit_backend = { ...(state.settings.runtime_settings.ai_audit_backend || {}) };
        }
        const data = await apiFetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            section: targetSection,
            runtime_settings: runtimeSettingsPayload,
            ...(targetSection === 'chains' ? { chain_configs: chainConfigs } : {}),
            ...(targetSection === 'ai'
              ? {
                  ai_providers: aiProviders,
                  ai_models: aiModels,
                }
              : {}),
            ...(targetSection === 'whitelist' ? { whitelist_patterns: whitelistPatterns } : {}),
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
        pushNotification('Settings saved', 'success');
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
            allowed_chains: Array.isArray(account.allowed_chains) ? account.allowed_chains : [],
            daily_review_target: Number(account.daily_review_target) > 0 ? Math.floor(Number(account.daily_review_target)) : 200,
            current_password: String(account.current_password || ''),
            new_password: String(account.new_password || ''),
            confirm_password: String(account.confirm_password || ''),
          }),
        });
        const updatedAccount = {
          ...(state.settings.runtime_settings.account || {}),
          ...(data.account || {}),
          available_chains: Array.isArray(data.account?.available_chains)
            ? data.account.available_chains.map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean)
            : (state.settings.runtime_settings.account?.available_chains || []),
          allowed_chains: Array.isArray(data.account?.allowed_chains)
            ? data.account.allowed_chains.map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean)
            : (state.settings.runtime_settings.account?.allowed_chains || []),
        };
        const visibleChains = updatedAccount.allowed_chains.length
          ? updatedAccount.allowed_chains
          : updatedAccount.available_chains;
        updatedAccount.allowed_chain_candidate = updatedAccount.available_chains.find(
          (chain) => !updatedAccount.allowed_chains.includes(chain),
        ) || updatedAccount.available_chains[0] || '';
        state.settings.runtime_settings.account = {
          ...updatedAccount,
          current_password: '',
          new_password: '',
          confirm_password: '',
        };
        state.chains = visibleChains;
        if (state.selectedChain && visibleChains.length && !visibleChains.includes(state.selectedChain)) {
          state.selectedChain = visibleChains[0];
        }
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
      openRunRoundModal,
      closeRunRoundModal,
      confirmRunRoundModal,
      syncTokenPrices,
      toggleAutoAnalysis,
      navigateDashboard,
      navigateToken,
      navigateContract,
      openDashboardMain,
      openContractsMain,
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
      openContractAuditResultDrawer,
      openTokenAuditResultDrawer,
      closeAuditReportDrawer,
      addAccountAllowedChain,
      addAutoAnalysisChain,
      removeAccountAllowedChain,
      removeAutoAnalysisChain,
      beginAutoAnalysisRatioDrag,
      beginAutoAnalysisMixDrag,
      addChainConfigRow,
      removeChainConfigRow,
      addAiProviderRow,
      removeAiProviderRow,
      addAiModelRow,
      removeAiModelRow,
      addWhitelistPatternRow,
      removeWhitelistPatternRow,
      createManagedUserAccount,
      deleteManagedUserAccount,
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
