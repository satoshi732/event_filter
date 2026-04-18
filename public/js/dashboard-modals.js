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
      prepareDashboardContractRows,
      prepareDashboardTokenRows,
      prepareTokenDetail,
      normalizeAiProvider,
      normalizeAiModel,
      contractReviewTargetOptions,
      ignoreNextReviewUpdate,
    } = deps;

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
      const target = (Array.isArray(input.targetOptions) ? input.targetOptions : []).find((entry) => entry.kind === targetKind)
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

      const currentDetailAddress = String(state.contractDetail?.address || '').toLowerCase();
      let insertedReview = false;
      if (currentDetailAddress === address && state.contractDetail) {
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
        const data = await apiFetch('/api/review', {
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
        applyLocalContractReviewUpdate({
          address: state.contractReviewModal.address,
          targetKind: state.contractReviewModal.target_kind,
          targetOptions: state.contractReviewModal.target_options,
          label: state.contractReviewModal.label,
          reviewText: state.contractReviewModal.review_text,
          exploitable: state.contractReviewModal.exploitable,
          hash: data?.hash || '',
          persistedOnly: Boolean(data?.persisted_only),
        });
        invalidateChainCache(state.selectedChain);
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
        applyLocalTokenReviewUpdate({
          token: state.tokenReviewModal.address,
          reviewText: state.tokenReviewModal.review_text,
          exploitable: state.tokenReviewModal.exploitable,
        });
        invalidateChainCache(state.selectedChain);
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
