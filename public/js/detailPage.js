import {
  apiFetch,
  bindCopyButtons,
  bindSortButtons,
  compareRows,
  compareStrings,
  contractLinkage,
  contractLookupFromGroups,
  createSyncController,
  formatAmount,
  formatRelativeAge,
  formatSyncMeta,
  formatText,
  formatUsd,
  nextSortState,
  renderCopyButton,
  renderPatternTargetOptions,
  renderReviewMeta,
  renderSortableHeader,
  reviewStatusClass,
  setCollapseToggleState,
  shortenAddress,
  sortRows,
  tokenDisplayName,
} from './shared.js';

async function initDetailPage() {
  const DETAIL_SYNC_REFRESH_MS = 60_000;
  const detailSummaryPanel = document.querySelector('#detailSummaryPanel');
  const detailSummaryToggle = document.querySelector('#detailSummaryToggle');
  const detailTitle = document.querySelector('#detailTitle');
  const detailMeta = document.querySelector('#detailMeta');
  const detailRunMeta = document.querySelector('#detailRunMeta');
  const detailSummaryBody = document.querySelector('#detailSummaryBody');
  const detailTables = document.querySelector('#detailTables');
  const backLink = document.querySelector('#backLink');
  const flowModal = document.querySelector('#flowModal');
  const flowModalHead = document.querySelector('#flowModalHead');
  const flowModalTitle = document.querySelector('#flowModalTitle');
  const flowModalMeta = document.querySelector('#flowModalMeta');
  const flowModalBody = document.querySelector('#flowModalBody');
  const flowModalClose = document.querySelector('#flowModalClose');
  const flowModalReviewButton = document.querySelector('#flowModalReviewButton');
  const reviewCard = document.querySelector('#reviewCard');
  const reviewTargetSelect = document.querySelector('#reviewTargetSelect');
  const reviewLabelInput = document.querySelector('#reviewLabelInput');
  const reviewExploitableSelect = document.querySelector('#reviewExploitableSelect');
  const reviewTextInput = document.querySelector('#reviewTextInput');
  const reviewFormMeta = document.querySelector('#reviewFormMeta');
  const reviewCancelButton = document.querySelector('#reviewCancelButton');
  const reviewSubmitButton = document.querySelector('#reviewSubmitButton');
  const syncController = createSyncController();
  const detailState = {
    contractSort: { key: 'current_balance', dir: 'desc' },
    flowSort: { key: 'total_flow', dir: 'desc' },
    activeFlowContract: null,
    reviewOpen: false,
  };
  const contractColumns = [
    { key: 'contract', label: 'Contract', type: 'string', defaultDir: 'asc', getValue: (row) => row.contract, tieBreaker: (row) => row.contract },
    { key: 'transfer_in_count', label: 'In Count', type: 'number', defaultDir: 'desc', getValue: (row) => row.transfer_in_count, tieBreaker: (row) => row.contract },
    { key: 'transfer_in_amount', label: 'In Amount', type: 'bigint', defaultDir: 'desc', getValue: (row) => row.transfer_in_amount, tieBreaker: (row) => row.contract },
    { key: 'transfer_out_count', label: 'Out Count', type: 'number', defaultDir: 'desc', getValue: (row) => row.transfer_out_count, tieBreaker: (row) => row.contract },
    { key: 'transfer_out_amount', label: 'Out Amount', type: 'bigint', defaultDir: 'desc', getValue: (row) => row.transfer_out_amount, tieBreaker: (row) => row.contract },
    { key: 'current_balance', label: 'Balance', type: 'bigint', defaultDir: 'desc', getValue: (row) => row.current_balance, tieBreaker: (row) => row.contract },
    { key: 'created_at', label: 'Created', type: 'date', defaultDir: 'desc', getValue: (row) => row.created_at, tieBreaker: (row) => row.contract },
    { key: 'linkage', label: 'Linkage', type: 'string', defaultDir: 'asc', getValue: (row) => contractLinkage(row), tieBreaker: (row) => row.contract },
    { key: 'matched_whitelist', label: 'Patterns', type: 'array', defaultDir: 'asc', getValue: (row) => row.matched_whitelist || [], tieBreaker: (row) => row.contract },
    { key: 'code_size', label: 'Code Size', type: 'number', defaultDir: 'desc', getValue: (row) => row.code_size, tieBreaker: (row) => row.contract },
  ];
  const flowColumns = [
    { key: 'label', label: 'Counterparty', type: 'string', defaultDir: 'asc', getValue: (row) => row.label, tieBreaker: (row) => row.label },
    { key: 'type', label: 'Type', type: 'string', defaultDir: 'asc', getValue: (row) => (row.is_contract ? 'Contract' : 'EOAs'), tieBreaker: (row) => row.label },
    { key: 'transfer_in_count', label: 'In Count', type: 'number', defaultDir: 'desc', getValue: (row) => row.transfer_in_count, tieBreaker: (row) => row.label },
    { key: 'transfer_in_amount', label: 'In Amount', type: 'bigint', defaultDir: 'desc', getValue: (row) => row.transfer_in_amount, tieBreaker: (row) => row.label },
    { key: 'transfer_out_count', label: 'Out Count', type: 'number', defaultDir: 'desc', getValue: (row) => row.transfer_out_count, tieBreaker: (row) => row.label },
    { key: 'transfer_out_amount', label: 'Out Amount', type: 'bigint', defaultDir: 'desc', getValue: (row) => row.transfer_out_amount, tieBreaker: (row) => row.label },
    { key: 'tx_count', label: 'TXs', type: 'number', defaultDir: 'desc', getValue: (row) => row.tx_count, tieBreaker: (row) => row.label },
    { key: 'total_flow', label: 'Total Flow', type: 'bigint', defaultDir: 'desc', getValue: (row) => row.total_flow, tieBreaker: (row) => row.label },
  ];

  const params = new URLSearchParams(window.location.search);
  const chain = (params.get('chain') || '').toLowerCase();
  const tokenAddress = (params.get('token') || '').toLowerCase();

  if (chain) {
    backLink.href = `/?chain=${encodeURIComponent(chain)}`;
  }

  function setSummaryCollapsed(collapsed) {
    if (!detailSummaryPanel || !detailSummaryToggle) return;
    detailSummaryPanel.classList.toggle('collapsed', collapsed);
    setCollapseToggleState(detailSummaryToggle, collapsed, 'Expand token info', 'Collapse token info');
  }

  detailSummaryToggle?.addEventListener('click', () => {
    if (!detailSummaryPanel) return;
    setSummaryCollapsed(!detailSummaryPanel.classList.contains('collapsed'));
  });

  if (!chain || !tokenAddress) {
    detailTitle.textContent = 'Token detail';
    detailMeta.textContent = 'Missing parameters';
    detailRunMeta.textContent = '';
    detailSummaryBody.innerHTML = '<tr><td>Missing chain or token.</td></tr>';
    detailTables.innerHTML = '<section class="panel"><div class="detail-empty">Missing chain or token.</div></section>';
    return;
  }

  const data = await apiFetch(`/api/token?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(tokenAddress)}`);
  const token = data.token;
  const run = data.run;
  let contractLookup = contractLookupFromGroups(token.groups);

  function sortDetailGroups(groups) {
    return groups
      .map((group) => ({
        ...group,
        contracts: sortRows(group.contracts, contractColumns, detailState.contractSort),
      }))
      .sort((left, right) => {
        const leftLead = left.contracts[0];
        const rightLead = right.contracts[0];
        if (!leftLead && !rightLead) return 0;
        if (!leftLead) return 1;
        if (!rightLead) return -1;
        const rowDelta = compareRows(leftLead, rightLead, contractColumns, detailState.contractSort);
        if (rowDelta !== 0) return rowDelta;
        return compareStrings(left.label, right.label);
      });
  }

  function renderContractHead() {
    return `
      <tr>
        ${contractColumns.map((column) => renderSortableHeader(column.label, column.key, detailState.contractSort)).join('')}
      </tr>
    `;
  }

  function renderFlowHead() {
    flowModalHead.innerHTML = `
      <tr>
        ${flowColumns.map((column) => renderSortableHeader(column.label, column.key, detailState.flowSort)).join('')}
      </tr>
    `;
    bindSortButtons(flowModalHead, (key) => {
      detailState.flowSort = nextSortState(detailState.flowSort, key, flowColumns);
      if (detailState.activeFlowContract) renderFlowModalTable(detailState.activeFlowContract);
    });
  }

  function renderFlowModalTable(contract) {
    const flowRows = sortRows(contract.flow_breakdown || [], flowColumns, detailState.flowSort);
    flowModalBody.innerHTML = flowRows.length
      ? flowRows.map((row) => `
          <tr>
            <td class="mono-cell">${row.label}</td>
            <td>${row.is_contract ? 'Contract' : 'EOAs'}</td>
            <td>${row.transfer_in_count}</td>
            <td>${formatAmount(row.transfer_in_amount, token.decimals)}</td>
            <td>${row.transfer_out_count}</td>
            <td>${formatAmount(row.transfer_out_amount, token.decimals)}</td>
            <td>${row.tx_count}</td>
            <td>${formatAmount(row.total_flow, token.decimals)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="8">No flow data.</td></tr>';
  }

  function closeFlowModal() {
    flowModal.classList.add('hidden');
    flowModal.setAttribute('aria-hidden', 'true');
  }

  function setReviewOpen(open) {
    detailState.reviewOpen = open;
    if (reviewCard) reviewCard.classList.toggle('hidden', !open);
  }

  function prepareReviewForm(contract) {
    if (reviewTargetSelect) {
      reviewTargetSelect.innerHTML = renderPatternTargetOptions(contract);
    }
    if (reviewFormMeta) {
      reviewFormMeta.textContent = 'Review will be saved to seen contracts and queued for pattern sync.';
    }
    syncReviewFormForSelectedTarget(contract);
  }

  function syncReviewFormForSelectedTarget(contract) {
    const selectedTargetKind = reviewTargetSelect instanceof HTMLSelectElement ? reviewTargetSelect.value : 'contract';
    const selectedTarget = (contract.pattern_targets || []).find((item) => item.kind === selectedTargetKind);
    const existing = contract.reviews?.find((item) => item.pattern_hash === selectedTarget?.pattern_hash);
    if (reviewLabelInput instanceof HTMLInputElement) {
      reviewLabelInput.value = existing?.label || '';
    }
    if (reviewTextInput instanceof HTMLTextAreaElement) {
      reviewTextInput.value = existing?.review_text || '';
    }
    if (reviewExploitableSelect instanceof HTMLSelectElement) {
      reviewExploitableSelect.value = existing?.exploitable ? 'true' : 'false';
    }
  }

  function openFlowModal(contract) {
    detailState.activeFlowContract = contract;
    setReviewOpen(false);
    if (flowModalReviewButton) {
      flowModalReviewButton.disabled = !(contract.pattern_targets || []).length;
    }
    flowModalTitle.textContent = `${tokenDisplayName(token)} / ${shortenAddress(contract.contract)}`;
    flowModalMeta.innerHTML = `
      <div class="modal-meta-line">
        <span class="mono-cell">${contract.contract}</span>
        <span>balance ${formatAmount(contract.current_balance, token.decimals)}</span>
        <span>linkage ${contractLinkage(contract)}</span>
        ${renderReviewMeta(contract)}
      </div>
    `;
    prepareReviewForm(contract);
    renderFlowHead();
    renderFlowModalTable(contract);
    flowModal.classList.remove('hidden');
    flowModal.setAttribute('aria-hidden', 'false');
  }

  function refreshActiveFlowModal() {
    if (!detailState.activeFlowContract || flowModal.classList.contains('hidden')) return;
    const refreshed = contractLookup.get(detailState.activeFlowContract.contract);
    if (!refreshed) {
      closeFlowModal();
      detailState.activeFlowContract = null;
      setReviewOpen(false);
      return;
    }

    detailState.activeFlowContract = refreshed;
    if (flowModalReviewButton) {
      flowModalReviewButton.disabled = !(refreshed.pattern_targets || []).length;
    }
    flowModalMeta.innerHTML = `
      <div class="modal-meta-line">
        <span class="mono-cell">${refreshed.contract}</span>
        <span>balance ${formatAmount(refreshed.current_balance, token.decimals)}</span>
        <span>linkage ${contractLinkage(refreshed)}</span>
        ${renderReviewMeta(refreshed)}
      </div>
    `;
    if (detailState.reviewOpen) {
      prepareReviewForm(refreshed);
    }
    renderFlowHead();
    renderFlowModalTable(refreshed);
  }

  async function refreshDetailReviews() {
    const latest = await apiFetch(`/api/token?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(tokenAddress)}`);
    if (!latest?.token?.groups) return;
    token.groups = latest.token.groups;
    contractLookup = contractLookupFromGroups(token.groups);
    renderDetailTables();
    refreshActiveFlowModal();
  }

  flowModalClose.addEventListener('click', closeFlowModal);
  flowModal.addEventListener('click', (event) => {
    if (event.target instanceof HTMLElement && event.target.dataset.closeFlowModal === 'true') {
      closeFlowModal();
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !flowModal.classList.contains('hidden')) {
      closeFlowModal();
    }
  });
  flowModalReviewButton?.addEventListener('click', () => {
    if (!detailState.activeFlowContract) return;
    prepareReviewForm(detailState.activeFlowContract);
    setReviewOpen(!detailState.reviewOpen);
  });
  reviewCancelButton?.addEventListener('click', () => setReviewOpen(false));
  reviewTargetSelect?.addEventListener('change', () => {
    if (detailState.activeFlowContract) {
      syncReviewFormForSelectedTarget(detailState.activeFlowContract);
    }
  });

  detailTitle.textContent = `${tokenDisplayName(token)} / ${token.is_native ? 'native' : token.token}`;
  detailMeta.textContent = `${token.related_contract_count} contracts  |  ${token.total_transfer_count} txs  |  total ${formatAmount(token.total_transfer_amount, token.decimals)}  |  price ${formatUsd(token.token_price_usd)}`;
  detailRunMeta.textContent = `${run.chain.toUpperCase()}  |  blocks ${run.block_from} -> ${run.block_to}  |  ${new Date(run.generated_at).toLocaleString()}`;
  setSummaryCollapsed(false);
  const tokenSyncCallText = token.token_calls_sync == null ? '--' : (token.token_calls_sync ? 'Yes' : 'No');

  detailSummaryBody.innerHTML = `
    <tr>
      <th>Token</th>
      <td>
        <div class="address-cell">
          <span>${token.is_native ? 'native' : token.token}</span>
          ${renderCopyButton(token.is_native ? '' : token.token)}
        </div>
      </td>
      <th>Name</th>
      <td>${formatText(token.token_name)}</td>
    </tr>
    <tr>
      <th>Symbol</th>
      <td>${formatText(token.token_symbol)}</td>
      <th>Price (USD)</th>
      <td>${formatUsd(token.token_price_usd)}</td>
    </tr>
    <tr>
      <th>Decimals</th>
      <td>${formatText(token.decimals)}</td>
      <th>Created</th>
      <td>${formatText(token.token_created_at)}</td>
    </tr>
    <tr>
      <th>Calls sync()</th>
      <td>${tokenSyncCallText}</td>
      <th>Contracts</th>
      <td>${token.related_contract_count}</td>
    </tr>
    <tr>
      <th>Total TXs</th>
      <td>${token.total_transfer_count}</td>
      <th>Total Transfer</th>
      <td>${formatAmount(token.total_transfer_amount, token.decimals)}</td>
    </tr>
  `;
  bindCopyButtons(detailSummaryBody);

  if (!token.groups.length) {
    detailTables.innerHTML = '<section class="panel"><div class="detail-empty">No grouped contracts.</div></section>';
    return;
  }

  function renderContractRow(contract, rowClass = '', isSeenGroupMember = false) {
    const classes = [
      rowClass,
      reviewStatusClass(contract, isSeenGroupMember),
      contract.is_exploitable ? 'exploitable-contract' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="${classes}">
        <td class="mono-cell">
          <div class="address-cell">
            <button class="flow-link" type="button" data-contract="${contract.contract}">${contract.contract}</button>
            ${renderCopyButton(contract.contract)}
          </div>
        </td>
        <td>${contract.transfer_in_count}</td>
        <td>${formatAmount(contract.transfer_in_amount, token.decimals)}</td>
        <td>${contract.transfer_out_count}</td>
        <td>${formatAmount(contract.transfer_out_amount, token.decimals)}</td>
        <td>${formatAmount(contract.current_balance, token.decimals)}</td>
        <td>${formatRelativeAge(contract.created_at)}</td>
        <td class="mono-cell">${contractLinkage(contract)}</td>
        <td>${(contract.matched_whitelist || []).join(', ') || '--'}</td>
        <td>${contract.code_size}</td>
      </tr>
    `;
  }

  function renderDetailTables() {
    const previousShell = detailTables.querySelector('.table-shell');
    const previousScrollTop = previousShell instanceof HTMLElement ? previousShell.scrollTop : 0;
    const previousScrollLeft = previousShell instanceof HTMLElement ? previousShell.scrollLeft : 0;
    const allGroups = sortDetailGroups(token.groups);

    const renderBody = allGroups.map((group) => {
      if (group.kind === 'single') {
        return group.contracts.map((contract) => renderContractRow(contract, 'group-member-row')).join('');
      }

      const headerRow = `
        <tr class="group-band-row group-band-header${group.kind === 'seen' ? ' seen-group-header' : ''}">
          <td colspan="10">${group.label}  |  ${group.contract_count} contracts  |  flow ${formatAmount(group.total_transfer_amount, token.decimals)}</td>
        </tr>
      `;

      const memberClass = group.kind === 'seen' ? 'group-member-row seen-member' : 'group-member-row similar-member';
      return `${headerRow}${group.contracts.map((contract) => renderContractRow(contract, memberClass, group.kind === 'seen')).join('')}`;
    }).join('');

    detailTables.innerHTML = `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Contracts</h2>
          </div>
          <div class="panel-stat">${allGroups.reduce((sum, group) => sum + group.contract_count, 0)} contracts</div>
        </div>
        <div class="table-shell">
          <table class="detail-table">
            <thead>
              ${renderContractHead()}
            </thead>
            <tbody>
              ${renderBody || '<tr><td colspan="10">No grouped contracts.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    `;

    detailTables.querySelectorAll('.flow-link').forEach((button) => {
      button.addEventListener('click', () => {
        const contract = contractLookup.get(button.dataset.contract);
        if (contract) openFlowModal(contract);
      });
    });
    bindCopyButtons(detailTables);
    bindSortButtons(detailTables, (key) => {
      detailState.contractSort = nextSortState(detailState.contractSort, key, contractColumns);
      renderDetailTables();
    });

    const nextShell = detailTables.querySelector('.table-shell');
    if (nextShell instanceof HTMLElement) {
      nextShell.scrollTop = previousScrollTop;
      nextShell.scrollLeft = previousScrollLeft;
    }
  }

  renderDetailTables();

  reviewSubmitButton?.addEventListener('click', async () => {
    const contract = detailState.activeFlowContract;
    const address = contract?.contract?.toLowerCase() || '';
    const label = (reviewLabelInput instanceof HTMLInputElement ? reviewLabelInput.value : '').trim();
    const reviewText = (reviewTextInput instanceof HTMLTextAreaElement ? reviewTextInput.value : '').trim();
    const targetKind = reviewTargetSelect instanceof HTMLSelectElement ? reviewTargetSelect.value : 'auto';
    const exploitable = reviewExploitableSelect instanceof HTMLSelectElement
      ? reviewExploitableSelect.value === 'true'
      : false;

    if (!address || !label) {
      if (reviewFormMeta) reviewFormMeta.textContent = 'Label is required.';
      return;
    }

    if (reviewSubmitButton) reviewSubmitButton.disabled = true;
    if (reviewFormMeta) reviewFormMeta.textContent = 'Saving review...';
    try {
      await apiFetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain, address, label, review_text: reviewText, exploitable, target_kind: targetKind }),
      });
      await syncController.refreshSyncStatus();
      const syncMeta = document.querySelector('#syncMeta');
      if (syncMeta) {
        syncMeta.textContent = `${formatSyncMeta(await apiFetch('/api/sync/status'))}  |  rerun scan to apply seen grouping`;
      }
      if (reviewFormMeta) reviewFormMeta.textContent = 'Review saved. Rerun scan to apply seen grouping.';
      if (contract) {
        const reviewTarget = (contract.pattern_targets || []).find((item) => item.kind === targetKind) ?? contract.pattern_targets?.[0];
        if (reviewTarget) {
          const nextReview = {
            id: Date.now(),
            chain,
            contract_address: contract.contract,
            pattern_hash: reviewTarget.pattern_hash,
            pattern_kind: reviewTarget.kind,
            pattern_address: reviewTarget.address,
            label,
            review_text: reviewText,
            exploitable,
            status: 'pending',
            updated_at: new Date().toISOString(),
          };
          const existing = (contract.reviews || []).filter((item) => item.pattern_hash !== nextReview.pattern_hash);
          contract.reviews = [nextReview, ...existing];
          contract.is_exploitable = contract.reviews.some((item) => item.exploitable);
          flowModalMeta.innerHTML = `
            <div class="modal-meta-line">
              <span class="mono-cell">${contract.contract}</span>
              <span>balance ${formatAmount(contract.current_balance, token.decimals)}</span>
              <span>linkage ${contractLinkage(contract)}</span>
              ${renderReviewMeta(contract)}
            </div>
          `;
          renderDetailTables();
          const refreshed = contractLookup.get(contract.contract);
          if (refreshed) {
            detailState.activeFlowContract = refreshed;
          }
        }
      }
      setReviewOpen(false);
    } catch (error) {
      if (reviewFormMeta) reviewFormMeta.textContent = error.message;
    } finally {
      if (reviewSubmitButton) reviewSubmitButton.disabled = false;
    }
  });

  await syncController.refreshSyncStatus();

  const detailRefreshTimer = window.setInterval(async () => {
    try {
      await syncController.refreshSyncStatus();
      await refreshDetailReviews();
    } catch {
      // Keep UI stable on transient polling failures.
    }
  }, DETAIL_SYNC_REFRESH_MS);

  window.addEventListener('beforeunload', () => {
    window.clearInterval(detailRefreshTimer);
  }, { once: true });
}

export { initDetailPage };
