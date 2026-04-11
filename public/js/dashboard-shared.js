(() => {
  const vueApi = window.Vue || {};
  const markRaw = typeof vueApi.markRaw === 'function' ? vueApi.markRaw : (value) => value;

  function toBigIntSafe(value) {
    try {
      if (value == null || value === '') return 0n;
      return BigInt(value);
    } catch {
      return 0n;
    }
  }

  function compareString(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
  }

  function compareNumber(a, b) {
    const left = Number(a);
    const right = Number(b);
    const safeLeft = Number.isFinite(left) ? left : Number.NEGATIVE_INFINITY;
    const safeRight = Number.isFinite(right) ? right : Number.NEGATIVE_INFINITY;
    return safeLeft - safeRight;
  }

  function compareBoolean(a, b) {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }

  function compareBigInt(a, b) {
    const left = toBigIntSafe(a);
    const right = toBigIntSafe(b);
    if (left === right) return 0;
    return left > right ? 1 : -1;
  }

  function parseStoredUtcDate(value) {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }

    const raw = String(value).trim();
    if (!raw) return null;

    const sqliteUtcMatch = raw.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/,
    );
    if (sqliteUtcMatch) {
      const [, year, month, day, hour, minute, second, millis = '0'] = sqliteUtcMatch;
      const date = new Date(Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(millis.padEnd(3, '0')),
      ));
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function compareDate(a, b) {
    const left = a ? (parseStoredUtcDate(a)?.getTime() ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
    const right = b ? (parseStoredUtcDate(b)?.getTime() ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
    const safeLeft = Number.isFinite(left) ? left : Number.NEGATIVE_INFINITY;
    const safeRight = Number.isFinite(right) ? right : Number.NEGATIVE_INFINITY;
    return safeLeft - safeRight;
  }

  function formatUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 2 : 6 })}`;
  }

  function formatBig(value) {
    if (value == null) return '--';
    try {
      return BigInt(value).toString();
    } catch {
      return String(value);
    }
  }

  function formatTokenAmount(value, decimals, maxFractionDigits = 6) {
    if (value == null || value === '') return '--';

    const raw = typeof value === 'bigint' ? value.toString() : String(value).trim();
    if (!/^-?\d+$/.test(raw)) return String(value);

    const parsedDecimals = Number(decimals);
    const safeDecimals = Number.isInteger(parsedDecimals) && parsedDecimals >= 0 ? parsedDecimals : 0;
    const negative = raw.startsWith('-');
    const digits = negative ? raw.slice(1) : raw;
    const normalized = digits.replace(/^0+(?=\d)/, '') || '0';
    const padded = safeDecimals > 0 ? normalized.padStart(safeDecimals + 1, '0') : normalized;
    const integerRaw = safeDecimals > 0 ? padded.slice(0, -safeDecimals) : padded;
    let fractionRaw = safeDecimals > 0 ? padded.slice(-safeDecimals) : '';

    if (fractionRaw) {
      fractionRaw = fractionRaw.replace(/0+$/, '');
      if (fractionRaw.length > maxFractionDigits) {
        fractionRaw = fractionRaw.slice(0, maxFractionDigits).replace(/0+$/, '');
      }
    }

    let integerDisplay = '0';
    try {
      integerDisplay = BigInt(integerRaw || '0').toLocaleString();
    } catch {
      integerDisplay = integerRaw || '0';
    }

    return `${negative ? '-' : ''}${integerDisplay}${fractionRaw ? `.${fractionRaw}` : ''}`;
  }

  function formatDateTime(value) {
    if (!value) return '--';
    const date = parseStoredUtcDate(value);
    if (!date) return String(value);
    return `${date.toLocaleString(undefined, { timeZone: 'UTC', hour12: false })} UTC`;
  }

  function formatRelativeTime(value) {
    if (!value) return '--';
    const date = parseStoredUtcDate(value);
    if (!date) return String(value);

    const diffMs = Date.now() - date.getTime();
    if (diffMs < 0) return formatDateTime(value);

    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;
    const month = 30 * day;
    const year = 365 * day;

    if (diffMs < minute) return 'just now';
    if (diffMs < hour) return `${Math.floor(diffMs / minute)} min`;
    if (diffMs < day) return `${Math.floor(diffMs / hour)} hr`;
    if (diffMs < week) return `${Math.floor(diffMs / day)} days`;
    if (diffMs < month) return `${Math.floor(diffMs / week)} weeks`;
    if (diffMs < year) return `${Math.floor(diffMs / month)} months`;
    return `${Math.floor(diffMs / year)} years`;
  }

  function shortAddress(value, head = 8, tail = 6) {
    if (!value || typeof value !== 'string') return '--';
    if (value.length <= head + tail + 3) return value;
    return `${value.slice(0, head)}...${value.slice(-tail)}`;
  }

  async function writeClipboardText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const el = document.createElement('textarea');
    el.value = value;
    el.setAttribute('readonly', 'true');
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }

  function syncStateLabel(value) {
    if (value === true) return 'detected';
    if (value === false) return 'missing';
    return 'unknown';
  }

  function syncStateTone(value) {
    if (value === true) return 'ok';
    if (value === false) return 'bad';
    return 'warn';
  }

  function autoAuditStatusTone(status) {
    switch (String(status || 'no')) {
      case 'yes':
        return 'ok';
      case 'processing':
        return 'warn';
      case 'failed':
        return 'bad';
      default:
        return 'bad';
    }
  }

  function autoAuditStatusLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'yes' || normalized === 'processing' || normalized === 'failed') return normalized;
    return 'no';
  }

  function autoAuditSeveritySummary(row) {
    const critical = Number(row?.auto_audit_critical);
    const high = Number(row?.auto_audit_high);
    const medium = Number(row?.auto_audit_medium);
    if (![critical, high, medium].some((value) => Number.isFinite(value) && value >= 0)) return '';
    return `c:${Number.isFinite(critical) ? critical : 0} h:${Number.isFinite(high) ? high : 0} m:${Number.isFinite(medium) ? medium : 0}`;
  }

  function auditResultDisplay(row) {
    return autoAuditStatusLabel(row?.auto_audit_status) === 'yes'
      ? (autoAuditSeveritySummary(row) || 'c:0 h:0 m:0')
      : '--';
  }

  function hasPatternSignature(row) {
    return Boolean(
      row?.selector_hash
      || (Array.isArray(row?.selectors) && row.selectors.length > 0)
      || (Array.isArray(row?.pattern_targets) && row.pattern_targets.length > 0),
    );
  }

  function hasSeenPattern(row) {
    return Boolean(
      row?.is_seen_pattern
      || row?.seen_label
      || row?.group_kind === 'seen',
    );
  }

  function contractVisualState(row) {
    if (!row) return 'default';
    if (row.is_manual_audit && !hasPatternSignature(row)) return 'manual-only';
    if (hasSeenPattern(row)) return 'seen';
    if (row.is_manual_audit && hasPatternSignature(row)) return 'reviewed';
    if (String(row.group_kind || '') === 'similar') {
      if (Number(row._group_size || 0) <= 1) return 'default';
      return 'similar';
    }
    return 'default';
  }

  function contractToneClass(row) {
    if (row?.is_exploitable) {
      return 'contract-row-tone-exploitable';
    }
    switch (contractVisualState(row)) {
      case 'seen':
        return 'contract-row-tone-seen';
      case 'similar':
        return 'contract-row-tone-similar';
      case 'reviewed':
        return 'contract-row-tone-reviewed';
      case 'manual-only':
        return 'contract-row-tone-manual-only';
      default:
        return '';
    }
  }

  function contractPatternGroupKey(row) {
    const state = contractVisualState(row);
    if (state === 'seen') {
      return `seen:${String(row.selector_hash || row.label || row.seen_label || row.group_label || row.contract || '').toLowerCase()}`;
    }
    if (state === 'similar') {
      return `similar:${String(row.selector_hash || row.group_label || row.contract || '').toLowerCase()}`;
    }
    if (state === 'reviewed') {
      return `reviewed:${String(row.selector_hash || row.label || row.contract || '').toLowerCase()}`;
    }
    return `single:${String(row.contract || '').toLowerCase()}`;
  }

  function contractPatternGroupLabel(row) {
    const state = contractVisualState(row);
    if (state === 'seen') return row.label || row.seen_label || row.group_label || 'Seen Pattern';
    if (state === 'similar') return row.group_label || 'Selector-similar group';
    if (state === 'reviewed') return row.label || row.group_label || 'Reviewed Pattern';
    return row.label || row.contract || 'Contract';
  }

  function buildPatternSections(rows) {
    const sections = [];
    const byKey = new Map();

    for (const row of rows) {
      const key = contractPatternGroupKey(row);
      let section = byKey.get(key);
      if (!section) {
        section = {
          key,
          title: contractPatternGroupLabel(row),
          toneClass: contractToneClass(row),
          kind: contractVisualState(row),
          rows: [],
        };
        byKey.set(key, section);
        sections.push(section);
      }
      section.rows.push(row);
    }

    return sections.map((section) => {
      const size = section.rows.length;
      section.rows.forEach((row) => {
        row._group_size = size;
      });
      return {
        ...section,
        isGrouped: size > 1 && section.kind !== 'manual-only',
      };
    });
  }

  function markRawRows(rows) {
    return markRaw((rows || []).map((row) => markRaw(row)));
  }

  function buildTokenSearchText(token) {
    return [
      token?.token,
      token?.token_name,
      token?.token_symbol,
    ].map((value) => String(value || '').toLowerCase()).join(' ');
  }

  function buildContractSearchText(contract) {
    return [
      contract?.contract,
      contract?.linkage,
      contract?.label,
      ...(contract?.patterns || []),
      ...((contract?.tokens || []).flatMap((token) => [
        token?.token,
        token?.token_symbol,
        token?.token_name,
      ])),
    ].map((value) => String(value || '').toLowerCase()).join(' ');
  }

  function prepareDashboardTokenRows(rows) {
    return markRawRows((rows || []).map((row) => ({
      ...row,
      _searchText: buildTokenSearchText(row),
    })));
  }

  function prepareDashboardContractRows(rows) {
    return markRawRows((rows || []).map((row) => ({
      ...row,
      _searchText: buildContractSearchText(row),
    })));
  }

  function prepareTokenDetail(detail) {
    if (!detail?.groups?.length) {
      return markRaw({
        contractsFlat: markRaw([]),
        groupCards: markRaw([]),
        exploitableCount: 0,
        largestBalance: '0',
      });
    }

    const contractsFlat = [];
    let exploitableCount = 0;
    let largestBalance = 0n;

    for (const group of detail.groups) {
      const groupContracts = group.contracts || [];
      let topBalance = 0n;
      let reviewedCount = 0;
      let groupExploitableCount = 0;

      for (const contract of groupContracts) {
        const currentBalance = toBigIntSafe(contract.current_balance);
        if (currentBalance > largestBalance) largestBalance = currentBalance;
        if (currentBalance > topBalance) topBalance = currentBalance;
        if (contract.is_exploitable) {
          exploitableCount += 1;
          groupExploitableCount += 1;
        }
        if ((contract.reviews || []).length > 0) reviewedCount += 1;

        contractsFlat.push({
          ...contract,
          whitelist_patterns: Array.isArray(contract.whitelist_patterns) && contract.whitelist_patterns.length
            ? contract.whitelist_patterns
            : (Array.isArray(contract.matched_whitelist) ? contract.matched_whitelist : []),
          group_kind: group.kind,
          group_label: group.label,
          group_contract_count: group.contract_count,
        });
      }

      group.groupCard = {
        id: group.id,
        kind: group.kind,
        label: group.label,
        contract_count: group.contract_count,
        total_transfer_amount: group.total_transfer_amount,
        exploitable_count: groupExploitableCount,
        reviewed_count: reviewedCount,
        top_balance: topBalance.toString(),
      };
    }

    return markRaw({
      contractsFlat: markRawRows(contractsFlat),
      groupCards: markRawRows(detail.groups.map((group) => group.groupCard)),
      exploitableCount,
      largestBalance: largestBalance.toString(),
    });
  }

  function prepareContractDetail(detail) {
    return markRaw({
      flowTokenOptions: markRawRows([...(detail?.tokens || [])].sort((a, b) =>
        compareString(a.token?.token_symbol || a.token?.token || '', b.token?.token_symbol || b.token?.token || ''))),
    });
  }

  window.EventFilterDashboardShared = {
    toBigIntSafe,
    compareString,
    compareNumber,
    compareBoolean,
    compareBigInt,
    compareDate,
    parseStoredUtcDate,
    formatUsd,
    formatBig,
    formatTokenAmount,
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
    buildPatternSections,
    prepareDashboardTokenRows,
    prepareDashboardContractRows,
    prepareTokenDetail,
    prepareContractDetail,
  };
})();
