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
      prepareDashboardContractRows,
      prepareTokenDetail,
      prepareContractDetail,
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

    function applySeenPatternPatch(row, labelByHash) {
      if (!row || typeof row !== 'object') return false;
      const directHash = String(row.selector_hash || '').toLowerCase();
      const directLabel = directHash ? labelByHash.get(directHash) : '';
      const targetList = Array.isArray(row.pattern_targets) ? row.pattern_targets : [];
      let matchedLabel = directLabel;

      if (!matchedLabel && targetList.length) {
        for (const target of targetList) {
          const nextHash = String(target?.pattern_hash || '').toLowerCase();
          if (!nextHash) continue;
          const label = labelByHash.get(nextHash);
          if (label) {
            matchedLabel = label;
            break;
          }
        }
      }

      if (!matchedLabel) return false;

      row.is_seen_pattern = true;
      row.group_kind = 'seen';
      row.group_label = row.label || row.seen_label || matchedLabel;
      row.seen_label = matchedLabel;
      if (!row.label) row.label = matchedLabel;

      if (targetList.length) {
        row.pattern_targets = targetList.map((target) => {
          const nextHash = String(target?.pattern_hash || '').toLowerCase();
          const nextLabel = labelByHash.get(nextHash);
          return nextLabel ? { ...target, seen_label: nextLabel } : target;
        });
      }

      return true;
    }

    function applySeenPatternPatchToCurrentState(patterns) {
      const labelByHash = new Map(
        (patterns || [])
          .map((row) => [String(row?.hash || '').toLowerCase(), String(row?.label || '')])
          .filter(([hash, label]) => hash && label),
      );
      if (!labelByHash.size) return false;

      let changed = false;

      if (Array.isArray(state.dashboard.contracts) && state.dashboard.contracts.length) {
        state.dashboard.contracts.forEach((row) => {
          if (applySeenPatternPatch(row, labelByHash)) changed = true;
        });
        if (changed) {
          state.prepared.dashboardContracts = prepareDashboardContractRows(state.dashboard.contracts);
        }
      }

      if (state.tokenDetail?.groups?.length) {
        state.tokenDetail.groups.forEach((group) => {
          if (!Array.isArray(group?.contracts)) return;
          group.contracts.forEach((row) => {
            if (applySeenPatternPatch(row, labelByHash)) changed = true;
          });
        });
        if (changed) {
          state.prepared.tokenDetail = prepareTokenDetail(state.tokenDetail);
        }
      }

      if (state.contractDetail) {
        const detailTargets = Array.isArray(state.contractDetail.pattern_targets) ? state.contractDetail.pattern_targets : [];
        const selectorHash = String(state.contractDetail.selector_hash || '').toLowerCase();
        const directLabel = selectorHash ? labelByHash.get(selectorHash) : '';
        let matchedLabel = directLabel;
        if (!matchedLabel) {
          for (const target of detailTargets) {
            const nextHash = String(target?.pattern_hash || '').toLowerCase();
            const label = labelByHash.get(nextHash);
            if (label) {
              matchedLabel = label;
              break;
            }
          }
        }
        if (matchedLabel) {
          state.contractDetail.pattern_targets = detailTargets.map((target) => {
            const nextHash = String(target?.pattern_hash || '').toLowerCase();
            const nextLabel = labelByHash.get(nextHash);
            return nextLabel ? { ...target, seen_label: nextLabel } : target;
          });
          if (!state.contractDetail.label) state.contractDetail.label = matchedLabel;
          state.prepared.contractDetail = prepareContractDetail(state.contractDetail);
          changed = true;
        }
      }

      return changed;
    }

    function handlePatternSyncSse(payload) {
      const status = payload?.status;
      if (status && typeof status === 'object') {
        state.syncStatus = status;
      }
      const pulledPatterns = Array.isArray(payload?.result?.patterns) ? payload.result.patterns : [];
      if (!pulledPatterns.length) return;
      invalidateChainCache(state.selectedChain);
      applySeenPatternPatchToCurrentState(pulledPatterns);
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
