function shortenAddress(address) {
  if (!address) return 'Unknown';
  if (address.startsWith('native:')) return 'native';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAmount(raw, decimals) {
  if (raw == null) return '--';
  try {
    const value = BigInt(raw);
    if (decimals == null) return value.toString();
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return String(raw);
  }
}

function formatUsd(raw) {
  if (raw == null) return '--';
  const value = Number(raw);
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  const maxFractionDigits =
    abs >= 1000 ? 2 :
    abs >= 1 ? 4 :
    abs >= 0.01 ? 6 :
    8;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits })}`;
}

function formatText(value) {
  if (value == null || value === '') return '--';
  return String(value);
}

function formatRelativeAge(value) {
  if (!value) return '--';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return '--';
  const diffMs = Date.now() - timestamp;
  if (diffMs <= 60 * 1000) return 'just now';
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

function tokenDisplayName(token) {
  return token.token_symbol || token.token_name || (token.is_native ? 'native' : shortenAddress(token.token));
}

function tokenAddressLabel(token) {
  return token.is_native ? 'native' : token.token;
}

function contractLinkage(contract) {
  if (contract.proxy_impl) return `proxy -> ${contract.proxy_impl}`;
  if (contract.eip7702_delegate) return `eip7702 -> ${contract.eip7702_delegate}`;
  return '--';
}

function toBigIntSafe(value) {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

function compareStrings(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

function compareValues(a, b, type) {
  if (type === 'bigint') {
    const delta = toBigIntSafe(a) - toBigIntSafe(b);
    if (delta === 0n) return 0;
    return delta > 0n ? 1 : -1;
  }
  if (type === 'number') {
    const left = Number(a ?? 0);
    const right = Number(b ?? 0);
    if (left === right) return 0;
    return left > right ? 1 : -1;
  }
  if (type === 'date') {
    const left = new Date(a ?? 0).getTime();
    const right = new Date(b ?? 0).getTime();
    if (left === right) return 0;
    return left > right ? 1 : -1;
  }
  if (type === 'array') {
    return compareStrings((a ?? []).join(', '), (b ?? []).join(', '));
  }
  return compareStrings(a, b);
}

function nextSortState(currentSort, key, columns) {
  if (currentSort?.key === key) {
    return { key, dir: currentSort.dir === 'asc' ? 'desc' : 'asc' };
  }
  const column = columns.find((item) => item.key === key);
  return {
    key,
    dir: column?.defaultDir || 'asc',
  };
}

function compareRows(left, right, columns, sortState) {
  const column = columns.find((item) => item.key === sortState.key) || columns[0];
  const direction = sortState.dir === 'asc' ? 1 : -1;
  const primary = compareValues(column.getValue(left), column.getValue(right), column.type);
  if (primary !== 0) return primary * direction;

  const tieLeft = column.tieBreaker ? column.tieBreaker(left) : '';
  const tieRight = column.tieBreaker ? column.tieBreaker(right) : '';
  return compareStrings(tieLeft, tieRight) * direction;
}

function sortRows(rows, columns, sortState) {
  return [...rows].sort((left, right) => compareRows(left, right, columns, sortState));
}

function renderSortableHeader(label, key, sortState) {
  const active = sortState.key === key;
  const indicator = active ? (sortState.dir === 'asc' ? '↑' : '↓') : '↕';
  return `
    <th>
      <button class="sort-button${active ? ' active' : ''}" type="button" data-sort-key="${key}">
        <span>${label}</span>
        <span class="sort-indicator">${indicator}</span>
      </button>
    </th>
  `;
}

function bindSortButtons(root, onSort) {
  root.querySelectorAll('.sort-button').forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      const key = button.dataset.sortKey;
      if (key) onSort(key);
    });
  });
}

function renderCopyButton(value, label = 'Copy') {
  if (!value || value === 'native') return '';
  return `<button class="copy-button" type="button" data-copy-value="${value}">${label}</button>`;
}

function renderPatternTargetOptions(contract) {
  return (contract.pattern_targets || []).map((target) => `
    <option value="${target.kind}">
      ${target.kind}  |  ${target.address}
    </option>
  `).join('');
}

function reviewStatusClass(contract, isSeenGroupMember = false) {
  const reviews = contract.reviews || [];
  if (!reviews.length) {
    if (contract.is_seen_pattern && !isSeenGroupMember) return 'review-synced-contract';
    return '';
  }
  const hasPendingLike = reviews.some((review) =>
    review.status === 'pending' || review.status === 'failed',
  );
  if (isSeenGroupMember) return hasPendingLike ? 'review-pending-contract' : '';
  return hasPendingLike ? 'review-pending-contract' : 'review-synced-contract';
}

function renderReviewMeta(contract) {
  const reviews = contract.reviews || [];
  if (!reviews.length) {
    return '<span class="modal-review-chip modal-review-chip-empty">review --</span>';
  }

  return reviews.map((review) => `
    <span class="modal-review-chip${review.exploitable ? ' exploitable-review-chip' : ''}">
      review ${formatText(review.label)}
    </span>
  `).join('');
}

function setCollapseToggleState(button, collapsed, expandLabel, collapseLabel) {
  if (!(button instanceof HTMLElement)) return;
  button.textContent = collapsed ? '▸' : '▾';
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  button.setAttribute('aria-label', collapsed ? expandLabel : collapseLabel);
  button.title = collapsed ? expandLabel : collapseLabel;
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

function bindCopyButtons(root = document) {
  root.querySelectorAll('.copy-button').forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', async () => {
      const value = button.dataset.copyValue;
      if (!value) return;
      const previous = button.textContent;
      try {
        await copyText(value);
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.textContent = previous || 'Copy';
        }, 1200);
      } catch (error) {
        button.textContent = 'Failed';
        window.setTimeout(() => {
          button.textContent = previous || 'Copy';
        }, 1200);
        window.alert(error.message);
      }
    });
  });
}

function contractLookupFromGroups(groups) {
  const lookup = new Map();
  groups.forEach((group) => {
    group.contracts.forEach((contract) => {
      lookup.set(contract.contract, contract);
    });
  });
  return lookup;
}

async function apiFetch(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function buildDetailUrl(chain, token) {
  return `/token.html?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}`;
}

function formatSyncMeta(status) {
  if (!status?.configured) return 'Sync not configured.';
  const pending = status.queue?.pending || 0;
  const prepared = status.queue?.prepared || 0;
  const parts = [
    `pending ${pending}`,
    `prepared ${prepared}`,
  ];
  if (status.lastPullAt) parts.push(`pull ${new Date(status.lastPullAt).toLocaleString()}`);
  return parts.join('  |  ');
}

function createSyncController() {
  const syncMeta = document.querySelector('#syncMeta');
  const pullButton = document.querySelector('#syncPullButton');
  const pushButton = document.querySelector('#syncPushButton');
  const verifyButton = document.querySelector('#syncVerifyButton');
  const buttons = [pullButton, pushButton, verifyButton].filter(Boolean);

  async function refreshSyncStatus() {
    if (!syncMeta) return null;
    try {
      const status = await apiFetch('/api/sync/status');
      syncMeta.textContent = formatSyncMeta(status);
      const disabled = !status.configured;
      buttons.forEach((button) => { button.disabled = disabled; });
      return status;
    } catch (error) {
      syncMeta.textContent = error.message;
      return null;
    }
  }

  async function runSyncAction(routePath) {
    if (!syncMeta) return null;
    buttons.forEach((button) => { button.disabled = true; });
    syncMeta.textContent = `Running ${routePath.split('/').pop()}...`;
    try {
      const data = await apiFetch(routePath, { method: 'POST' });
      syncMeta.textContent = formatSyncMeta(data.status);
      return data;
    } catch (error) {
      syncMeta.textContent = error.message;
      throw error;
    } finally {
      await refreshSyncStatus();
    }
  }

  if (pullButton) {
    pullButton.addEventListener('click', () => runSyncAction('/api/sync/pull').catch(() => {}));
  }
  if (pushButton) {
    pushButton.addEventListener('click', () => runSyncAction('/api/sync/push').catch(() => {}));
  }
  if (verifyButton) {
    verifyButton.addEventListener('click', async () => {
      try {
        const data = await runSyncAction('/api/sync/verify');
        if (data?.result?.mismatches?.length) {
          window.alert(`Verify found ${data.result.mismatches.length} mismatch(es). Check console/API if needed.`);
        }
      } catch {}
    });
  }

  return { refreshSyncStatus };
}

export {
  apiFetch,
  bindCopyButtons,
  bindSortButtons,
  buildDetailUrl,
  compareRows,
  compareStrings,
  contractLinkage,
  contractLookupFromGroups,
  createSyncController,
  formatAmount,
  formatUsd,
  formatRelativeAge,
  formatSyncMeta,
  formatText,
  nextSortState,
  renderCopyButton,
  renderPatternTargetOptions,
  renderReviewMeta,
  renderSortableHeader,
  reviewStatusClass,
  setCollapseToggleState,
  shortenAddress,
  sortRows,
  tokenAddressLabel,
  tokenDisplayName,
};
