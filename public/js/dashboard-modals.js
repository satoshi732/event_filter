(() => {
  function createDashboardModals(deps) {
    const {
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
      ignoreNextReviewUpdate,
    } = deps;

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

    function openContractLinkageModal() {
      const detail = state.contractDetail;
      if (!detail?.address) return;
      state.contractLinkageModal.open = true;
      state.contractLinkageModal.link_type = String(detail.link_type || '').toLowerCase();
      state.contractLinkageModal.linkage = String(detail.linkage || '').trim().toLowerCase();
      state.contractLinkageModal.saving = false;
      state.contractLinkageModal.error = '';
    }

    function closeContractLinkageModal() {
      state.contractLinkageModal.open = false;
      state.contractLinkageModal.saving = false;
      state.contractLinkageModal.error = '';
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
        ignoreNextReviewUpdate(state.selectedChain, 'contract', state.contractReviewModal.address);
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
        ignoreNextReviewUpdate(state.selectedChain, 'token', state.tokenReviewModal.address);
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

    async function saveContractLinkageModal() {
      if (!state.contractDetail?.address) return;
      const nextType = String(state.contractLinkageModal.link_type || '').trim().toLowerCase();
      const nextLinkage = String(state.contractLinkageModal.linkage || '').trim().toLowerCase();
      if ((nextType === 'proxy' || nextType === 'eip7702') && !nextLinkage) {
        state.contractLinkageModal.error = 'Implementation address is required.';
        return;
      }

      state.contractLinkageModal.saving = true;
      state.contractLinkageModal.error = '';
      try {
        await apiFetch('/api/contract-linkage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chain: state.selectedChain,
            contract: state.contractDetail.address,
            link_type: nextType,
            linkage: nextType ? nextLinkage : '',
          }),
        });
        invalidateChainCache(state.selectedChain);
        await loadContractDetail({ force: true });
        closeContractLinkageModal();
      } catch (err) {
        state.contractLinkageModal.error = err instanceof Error ? err.message : String(err);
      } finally {
        state.contractLinkageModal.saving = false;
      }
    }

    return {
      hydrateReviewForm,
      hydrateTokenReviewForm,
      toggleTokenReviewEditor,
      selectReviewTarget,
      buildContractReviewTargets,
      syncContractReviewModalForSelectedTarget,
      openContractReviewModal,
      closeContractReviewModal,
      openContractLinkageModal,
      closeContractLinkageModal,
      saveContractLinkageModal,
      openTokenReviewModal,
      closeTokenReviewModal,
      saveContractReviewModal,
      saveTokenReviewModal,
    };
  }

  window.EventFilterDashboardModals = {
    createDashboardModals,
  };
})();
