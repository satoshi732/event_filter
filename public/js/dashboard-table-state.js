(() => {
  function createDashboardTableState(deps) {
    const {
      state,
      currentView,
      TABLE_PAGE_SIZE,
      PAGE_SIZE_OPTIONS,
      sortStorageKey,
      persistStoredPageSizes,
      writeJsonStorage,
      scheduleCollectionReload,
      getTokenRelatedContractCount,
    } = deps;

    function getTableSort(tableId) {
      return state.tableSorts[tableId] || { key: '', dir: 'asc' };
    }

    function persistTableSorts() {
      writeJsonStorage(window.localStorage, sortStorageKey, state.tableSorts);
    }

    function toggleTableSort(tableId, key) {
      const current = getTableSort(tableId);
      state.tableSorts[tableId] = {
        key,
        dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc',
      };
      if (Object.prototype.hasOwnProperty.call(state.tablePages, tableId)) {
        state.tablePages[tableId] = 1;
      }
      persistTableSorts();
    }

    function sortIndicator(tableId, key) {
      const current = getTableSort(tableId);
      if (current.key !== key) return '';
      return current.dir === 'asc' ? '▲' : '▼';
    }

    function isActiveSort(tableId, key) {
      return getTableSort(tableId).key === key;
    }

    function getTablePageSize(tableId) {
      return Math.max(1, Number(state.tablePageSizes?.[tableId] || TABLE_PAGE_SIZE[tableId] || 25));
    }

    function getTablePage(tableId) {
      return Math.max(1, Number(state.tablePages?.[tableId] || 1));
    }

    function getTableRowCount(tableId) {
      switch (tableId) {
        case 'contractOverview':
          return Number(state.listMeta.contractOverview?.totalRows || 0);
        case 'tokenDirectory':
          return Number(state.listMeta.tokenDirectory?.totalRows || 0);
        case 'tokenRelatedContracts':
          return getTokenRelatedContractCount();
        default:
          return 0;
      }
    }

    function getTableTotalPages(tableId, totalRowsOverride) {
      const totalRows = Number(
        totalRowsOverride == null ? getTableRowCount(tableId) : totalRowsOverride,
      ) || 0;
      return Math.max(1, Math.ceil(totalRows / getTablePageSize(tableId)));
    }

    function setTablePage(tableId, page) {
      if (!Object.prototype.hasOwnProperty.call(state.tablePages, tableId)) return;
      const totalPages = getTableTotalPages(tableId);
      state.tablePages[tableId] = Math.max(1, Math.min(totalPages, Math.floor(Number(page) || 1)));
    }

    function resetTablePage(tableId) {
      if (!Object.prototype.hasOwnProperty.call(state.tablePages, tableId)) return;
      state.tablePages[tableId] = 1;
    }

    function setTablePageSize(tableId, size) {
      if (!Object.prototype.hasOwnProperty.call(state.tablePageSizes, tableId)) return;
      const normalizedSize = PAGE_SIZE_OPTIONS.includes(Number(size))
        ? Number(size)
        : (TABLE_PAGE_SIZE[tableId] || 25);
      if (getTablePageSize(tableId) === normalizedSize) return;
      state.tablePageSizes[tableId] = normalizedSize;
      resetTablePage(tableId);
      persistStoredPageSizes(state.tablePageSizes);
      if (tableId === 'contractOverview' && currentView.value === 'dashboard' && state.dashboardTab === 'contracts') {
        scheduleCollectionReload('contracts');
      }
      if (tableId === 'tokenDirectory' && currentView.value === 'token') {
        scheduleCollectionReload('tokens');
      }
    }

    function paginateRows(rows, tableId) {
      const list = Array.isArray(rows) ? rows : [];
      const totalPages = getTableTotalPages(tableId, list.length);
      const page = Math.max(1, Math.min(getTablePage(tableId), totalPages));
      if (page !== getTablePage(tableId) && Object.prototype.hasOwnProperty.call(state.tablePages, tableId)) {
        state.tablePages[tableId] = page;
      }
      const pageSize = getTablePageSize(tableId);
      const start = (page - 1) * pageSize;
      return list.slice(start, start + pageSize);
    }

    function getTablePaginationMeta(tableId, totalRowsOverride) {
      const totalRows = Number(
        totalRowsOverride == null ? getTableRowCount(tableId) : totalRowsOverride,
      ) || 0;
      const totalPages = getTableTotalPages(tableId, totalRows);
      const page = Math.max(1, Math.min(getTablePage(tableId), totalPages));
      const pageSize = getTablePageSize(tableId);
      const start = totalRows ? ((page - 1) * pageSize) + 1 : 0;
      const end = totalRows ? Math.min(totalRows, page * pageSize) : 0;
      return { page, totalPages, totalRows, start, end };
    }

    function canMoveTablePage(tableId, direction) {
      const meta = getTablePaginationMeta(tableId);
      return direction < 0 ? meta.page > 1 : meta.page < meta.totalPages;
    }

    function moveTablePage(tableId, direction) {
      setTablePage(tableId, getTablePage(tableId) + direction);
    }

    function goToTablePage(tableId, page) {
      setTablePage(tableId, page);
    }

    function getTablePageButtons(tableId, totalRowsOverride) {
      const meta = getTablePaginationMeta(tableId, totalRowsOverride);
      if (meta.totalPages <= 1) return [1];
      const pages = new Set([1, meta.totalPages, meta.page - 1, meta.page, meta.page + 1]);
      if (meta.page <= 3) {
        pages.add(2);
        pages.add(3);
      }
      if (meta.page >= meta.totalPages - 2) {
        pages.add(meta.totalPages - 1);
        pages.add(meta.totalPages - 2);
      }
      return [...pages]
        .filter((page) => page >= 1 && page <= meta.totalPages)
        .sort((left, right) => left - right)
        .reduce((acc, page) => {
          if (acc.length && typeof acc[acc.length - 1] === 'number' && page - acc[acc.length - 1] > 1) {
            acc.push('ellipsis');
          }
          acc.push(page);
          return acc;
        }, []);
    }

    return {
      getTableSort,
      toggleTableSort,
      sortIndicator,
      isActiveSort,
      getTablePageSize,
      getTablePage,
      setTablePage,
      resetTablePage,
      setTablePageSize,
      paginateRows,
      getTablePaginationMeta,
      canMoveTablePage,
      moveTablePage,
      goToTablePage,
      getTablePageButtons,
    };
  }

  window.EventFilterDashboardTableState = {
    createDashboardTableState,
  };
})();
