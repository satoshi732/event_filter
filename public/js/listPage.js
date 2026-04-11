import {
  apiFetch,
  bindCopyButtons,
  bindSortButtons,
  buildDetailUrl,
  createSyncController,
  formatAmount,
  formatRelativeAge,
  formatSyncMeta,
  formatUsd,
  nextSortState,
  renderCopyButton,
  renderSortableHeader,
  sortRows,
  tokenAddressLabel,
} from './shared.js';

async function initListPage() {
  const params = new URLSearchParams(window.location.search);
  const state = {
    chains: [],
    selectedChain: (params.get('chain') || '').toLowerCase() || null,
    running: false,
    latestRuns: [],
    summaries: [],
    sort: { key: 'related_contract_count', dir: 'desc' },
  };

  const chainSelect = document.querySelector('#chainSelect');
  const runButton = document.querySelector('#runButton');
  const statusBadge = document.querySelector('#statusBadge');
  const runMeta = document.querySelector('#runMeta');
  const tokenStats = document.querySelector('#tokenStats');
  const tokenTableHead = document.querySelector('#tokenTableHead');
  const tokenTableBody = document.querySelector('#tokenTableBody');
  const syncController = createSyncController();
  const listColumns = [
    { key: 'token', label: 'Token Address', type: 'string', defaultDir: 'asc', getValue: (row) => tokenAddressLabel(row), tieBreaker: (row) => row.token },
    { key: 'token_name', label: 'Name', type: 'string', defaultDir: 'asc', getValue: (row) => row.token_name || '' },
    { key: 'token_symbol', label: 'Symbol', type: 'string', defaultDir: 'asc', getValue: (row) => row.token_symbol || '' },
    { key: 'token_price_usd', label: 'Price (USD)', type: 'number', defaultDir: 'desc', getValue: (row) => (row.token_price_usd == null ? -1 : row.token_price_usd), tieBreaker: (row) => row.token },
    { key: 'token_created_at', label: 'Created', type: 'date', defaultDir: 'desc', getValue: (row) => row.token_created_at, tieBreaker: (row) => row.token },
    { key: 'token_calls_sync', label: 'Calls sync()', type: 'number', defaultDir: 'desc', getValue: (row) => (row.token_calls_sync == null ? -1 : (row.token_calls_sync ? 1 : 0)), tieBreaker: (row) => row.token },
    { key: 'related_contract_count', label: 'Contracts', type: 'number', defaultDir: 'desc', getValue: (row) => row.related_contract_count, tieBreaker: (row) => row.token },
    { key: 'total_transfer_count', label: 'Total TXs', type: 'number', defaultDir: 'desc', getValue: (row) => row.total_transfer_count, tieBreaker: (row) => row.token },
    { key: 'total_transfer_amount', label: 'Total Transfer', type: 'bigint', defaultDir: 'desc', getValue: (row) => row.total_transfer_amount, tieBreaker: (row) => row.token },
  ];

  function setStatus(kind, text) {
    statusBadge.textContent = text;
    statusBadge.className = `status-badge ${kind}`;
  }

  function renderChains() {
    chainSelect.innerHTML = '';
    state.chains.forEach((chain) => {
      const option = document.createElement('option');
      option.value = chain;
      option.textContent = chain.toUpperCase();
      option.selected = chain === state.selectedChain;
      chainSelect.appendChild(option);
    });
  }

  function renderRunMeta(run) {
    if (!run) {
      runMeta.textContent = 'No scan yet.';
      return;
    }
    runMeta.textContent = `${run.chain.toUpperCase()}  |  blocks ${run.block_from} -> ${run.block_to}  |  ${new Date(run.generated_at).toLocaleString()}`;
  }

  function renderTokenTableHead() {
    tokenTableHead.innerHTML = `
      <tr>
        ${listColumns.map((column) => renderSortableHeader(column.label, column.key, state.sort)).join('')}
      </tr>
    `;
    bindSortButtons(tokenTableHead, (key) => {
      state.sort = nextSortState(state.sort, key, listColumns);
      renderTokenTableHead();
      renderTokenTable();
    });
  }

  function renderTokenTable() {
    const sortedRows = sortRows(state.summaries, listColumns, state.sort);
    tokenStats.textContent = `${sortedRows.length} tokens`;

    if (!sortedRows.length) {
      tokenTableBody.innerHTML = `
        <tr>
          <td colspan="9" class="empty-row">No results for this chain.</td>
        </tr>
      `;
      return;
    }

    tokenTableBody.innerHTML = sortedRows.map((token) => `
      <tr>
        <td>
          <div class="address-cell">
            <a class="token-link" href="${buildDetailUrl(state.selectedChain, token.token)}">${tokenAddressLabel(token)}</a>
            ${renderCopyButton(token.is_native ? '' : token.token)}
          </div>
        </td>
        <td>${token.token_name || '--'}</td>
        <td>${token.token_symbol || '--'}</td>
        <td>${formatUsd(token.token_price_usd)}</td>
        <td>${formatRelativeAge(token.token_created_at)}</td>
        <td>${token.token_calls_sync == null ? '--' : (token.token_calls_sync ? 'Yes' : 'No')}</td>
        <td>${token.related_contract_count}</td>
        <td>${token.total_transfer_count}</td>
        <td>${formatAmount(token.total_transfer_amount, token.decimals)}</td>
      </tr>
    `).join('');

    bindCopyButtons(tokenTableBody);
  }

  async function loadSummaries(chain) {
    try {
      const data = await apiFetch(`/api/results?chain=${encodeURIComponent(chain)}`);
      state.summaries = data.tokens || [];
      renderRunMeta(data);
      renderTokenTable();
    } catch {
      state.summaries = [];
      renderRunMeta(null);
      renderTokenTable();
    }
  }

  async function loadState() {
    const data = await apiFetch('/api/state');
    state.chains = data.chains || [];
    state.selectedChain = state.selectedChain || data.default_chain || state.chains[0] || null;
    state.running = Boolean(data.running);
    state.latestRuns = data.latest_runs || [];

    renderChains();
    if (data.sync_status) {
      const syncMeta = document.querySelector('#syncMeta');
      if (syncMeta) syncMeta.textContent = formatSyncMeta(data.sync_status);
    } else {
      await syncController.refreshSyncStatus();
    }

    const latest = state.latestRuns.find((run) => run.chain === state.selectedChain);
    renderRunMeta(latest);
    if (state.selectedChain && latest) {
      await loadSummaries(state.selectedChain);
    } else {
      state.summaries = [];
      renderTokenTable();
    }

    setStatus(state.running ? 'running' : 'idle', state.running ? 'Running' : 'Waiting');
  }

  async function runAnalysis() {
    if (!state.selectedChain || state.running) return;

    state.running = true;
    runButton.disabled = true;
    setStatus('running', 'Running');
    runMeta.textContent = `Analyzing ${state.selectedChain.toUpperCase()}...`;

    try {
      await apiFetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain: state.selectedChain }),
      });
      await loadState();
    } catch (error) {
      setStatus('error', 'Error');
      runMeta.textContent = error.message;
    } finally {
      state.running = false;
      runButton.disabled = false;
      if (!statusBadge.classList.contains('error')) {
        setStatus('idle', 'Waiting');
      }
    }
  }

  chainSelect.addEventListener('change', async (event) => {
    state.selectedChain = event.target.value;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('chain', state.selectedChain);
    window.history.replaceState({}, '', nextUrl);
    await loadSummaries(state.selectedChain);
  });

  runButton.addEventListener('click', runAnalysis);

  renderTokenTableHead();
  await loadState();
  await syncController.refreshSyncStatus();
}

export { initListPage };
