(() => {
  function createDashboardScrollSync(deps) {
    const {
      router,
      nextTick,
      state,
      currentView,
      compareString,
      readJsonStorage,
      writeJsonStorage,
      previousRouteStorageKey,
      previousRouteScrollStorageKey,
      scrollStorageKey,
    } = deps;

    let pendingExplicitRestoreKey = '';
    let pendingExplicitRestorePosition = 0;

    function toRouteQueryObject(value) {
      if (!value) return {};
      if (typeof value === 'string') {
        const params = new URLSearchParams(value.startsWith('?') ? value.slice(1) : value);
        const result = {};
        params.forEach((entry, key) => {
          result[key] = entry;
        });
        return result;
      }
      return value;
    }

    function routeStorageKey(routeLike) {
      const path = String(routeLike?.path || routeLike?.name || window.location.pathname || '/');
      const queryObject = toRouteQueryObject(routeLike?.query || '');
      const parts = Object.entries(queryObject)
        .filter(([, value]) => value != null && value !== '')
        .sort(([left], [right]) => compareString(left, right))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      return parts.length ? `${path}?${parts.join('&')}` : path;
    }

    function currentRelativeRoute() {
      return routeStorageKey(router?.currentRoute?.value || {
        path: window.location.pathname,
        query: window.location.search,
      });
    }

    function rememberCurrentRoute() {
      try {
        window.sessionStorage.setItem(previousRouteStorageKey, currentRelativeRoute());
      } catch {}
    }

    function rememberCurrentRouteScroll() {
      try {
        window.sessionStorage.setItem(
          previousRouteScrollStorageKey,
          String(window.scrollY || window.pageYOffset || 0),
        );
      } catch {}
    }

    function persistScrollForRoute(routeLike, position) {
      const positions = readJsonStorage(window.sessionStorage, scrollStorageKey, {});
      positions[routeStorageKey(routeLike)] = Number.isFinite(Number(position))
        ? Number(position)
        : (window.scrollY || window.pageYOffset || 0);
      writeJsonStorage(window.sessionStorage, scrollStorageKey, positions);
    }

    function persistCurrentScroll() {
      persistScrollForRoute(router.currentRoute.value);
    }

    function rememberCurrentRouteContext() {
      rememberCurrentRoute();
      rememberCurrentRouteScroll();
      persistCurrentScroll();
    }

    function restoreScrollPosition(target) {
      const attempts = [0, 80, 180, 320];
      attempts.forEach((delay) => {
        window.setTimeout(() => {
          window.requestAnimationFrame(() => {
            window.scrollTo(0, target);
          });
        }, delay);
      });
    }

    async function restoreCurrentScroll(routeLike = router.currentRoute.value) {
      await nextTick();
      const positions = readJsonStorage(window.sessionStorage, scrollStorageKey, {});
      const target = Number(positions[routeStorageKey(routeLike)] || 0);
      if (!Number.isFinite(target) || target <= 0) return;
      restoreScrollPosition(target);
    }

    function dashboardUrlParams() {
      return {
        chain: state.selectedChain,
        tab: state.dashboardTab,
        st: state.dashboardTab === 'settings' ? state.settingsSection : '',
      };
    }

    async function updateUrl(path, params = {}) {
      const queryParams = {};
      Object.entries(params).forEach(([key, value]) => {
        if (value == null || value === '') return;
        queryParams[key] = String(value);
      });

      const nextRouteKey = routeStorageKey({ path, query: queryParams });
      const currentRouteKey = routeStorageKey(router.currentRoute.value);
      if (nextRouteKey === currentRouteKey) return;

      const currentScroll = window.scrollY || window.pageYOffset || 0;
      persistScrollForRoute(router.currentRoute.value, currentScroll);
      await router.replace({ path, query: queryParams }).catch(() => {});
      persistScrollForRoute({ path, query: queryParams }, currentScroll);
    }

    function syncDashboardUrlState() {
      if (currentView.value !== 'dashboard') return;
      updateUrl('/', dashboardUrlParams());
    }

    function syncTokenUrlState() {
      if (currentView.value !== 'token') return;
      updateUrl('/token', {
        chain: state.selectedChain,
      });
    }

    function setPendingRestoreState(key, position) {
      pendingExplicitRestoreKey = key;
      pendingExplicitRestorePosition = position;
    }

    function consumePendingRestoreState() {
      const result = {
        key: pendingExplicitRestoreKey,
        position: pendingExplicitRestorePosition,
      };
      pendingExplicitRestoreKey = '';
      pendingExplicitRestorePosition = 0;
      return result;
    }

    function goBackToPrevious(fallbackView = 'dashboard') {
      persistCurrentScroll();
      try {
        const previous = window.sessionStorage.getItem(previousRouteStorageKey);
        const previousScroll = Number(window.sessionStorage.getItem(previousRouteScrollStorageKey) || 0);
        if (previous && previous !== currentRelativeRoute()) {
          setPendingRestoreState(previous, Number.isFinite(previousScroll) ? previousScroll : 0);
          router.push(previous).catch(() => {});
          return;
        }
      } catch {}

      if (fallbackView === 'token') {
        router.push({
          path: '/token',
          query: { chain: state.selectedChain },
        }).catch(() => {});
        return;
      }

      router.push({
        path: '/',
        query: { chain: state.selectedChain },
      }).catch(() => {});
    }

    return {
      routeStorageKey,
      currentRelativeRoute,
      rememberCurrentRoute,
      rememberCurrentRouteScroll,
      persistScrollForRoute,
      persistCurrentScroll,
      rememberCurrentRouteContext,
      restoreScrollPosition,
      restoreCurrentScroll,
      dashboardUrlParams,
      updateUrl,
      syncDashboardUrlState,
      syncTokenUrlState,
      consumePendingRestoreState,
      goBackToPrevious,
    };
  }

  window.EventFilterDashboardScrollSync = {
    createDashboardScrollSync,
  };
})();
