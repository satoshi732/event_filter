(() => {
  function createDashboardRouting(deps) {
    const {
      state,
      router,
      currentView,
      startStateFetch,
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
    } = deps;

    let stateEventSource = null;
    let stateStreamReadyPromise = null;
    let resolveStateStreamReady = null;
    let stateStreamReady = false;

    function startStateStream(handleAiAuditSse, handleAutoAnalysisSse, handlePatternSyncSse, handleReviewUpdatedSse, handleDataRefreshSse) {
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
        stateEventSource.onerror = () => {};
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
      }
    }

    async function bootstrap(syncStateFromRoute) {
      try {
        await router.isReady();
        syncStateFromRoute();
        await Promise.race([
          startStateStream(handleAiAuditSse, handleAutoAnalysisSse, handlePatternSyncSse, handleReviewUpdatedSse, handleDataRefreshSse),
          new Promise((resolve) => window.setTimeout(resolve, 1200)),
        ]);
        if (!state.chains.length) {
          const data = await startStateFetch();
          await applyStatePayload(data);
        }
        if (currentView.value === 'dashboard' && (state.dashboardTab === 'settings' || state.dashboardTab === 'auto')) {
          await loadSettings({ showLoading: false });
        }
        await loadViewDataForCurrentRoute();
        await restoreCurrentScroll();
      } catch (err) {
        pushNotification(err instanceof Error ? err.message : String(err), 'error', 6000);
      }
    }

    return {
      startStateStream,
      handleAiAuditSse,
      handleAutoAnalysisSse,
      handlePatternSyncSse,
      handleReviewUpdatedSse,
      handleDataRefreshSse,
      bootstrap,
    };
  }

  window.EventFilterDashboardRouting = {
    createDashboardRouting,
  };
})();
