(() => {
  function installDashboardViewState(deps) {
    const {
      onMounted,
      watch,
      router,
      state,
      currentView,
      routeToken,
      syncStateFromRoute,
      loadViewDataForCurrentRoute,
      restoreCurrentScroll,
      currentRelativeRoute,
      restoreScrollPosition,
      consumePendingRestoreState,
      persistCurrentScroll,
      persistScrollForRoute,
      syncDashboardUrlState,
      syncTokenUrlState,
      persistStoredFilters,
      resetTablePage,
      scheduleCollectionReload,
      normalizeAiProvider,
      normalizeAiModel,
      bootstrap,
    } = deps;

    onMounted(async () => {
      await bootstrap(syncStateFromRoute);

      window.addEventListener('scroll', persistCurrentScroll, { passive: true });
      window.addEventListener('beforeunload', persistCurrentScroll);
    });

    router.beforeEach((to, from, next) => {
      persistScrollForRoute(from);
      next();
    });

    watch(
      () => router.currentRoute.value.fullPath,
      async () => {
        syncStateFromRoute();
        await loadViewDataForCurrentRoute();
        await restoreCurrentScroll();
        const pendingRestore = consumePendingRestoreState();
        if (pendingRestore.key && pendingRestore.key === currentRelativeRoute()) {
          if (pendingRestore.position > 0) {
            restoreScrollPosition(pendingRestore.position);
          }
        }
      },
    );

    watch(
      () => [
        currentView.value,
        state.selectedChain,
        state.dashboardTab,
        state.settingsSection,
      ],
      () => {
        syncDashboardUrlState();
        syncTokenUrlState();
      },
    );

    watch(
      () => ({
        tokenQuery: state.dashboardFilters.tokenQuery,
        contractQuery: state.dashboardFilters.contractQuery,
        contractRisk: state.dashboardFilters.contractRisk,
        contractLinkType: state.dashboardFilters.contractLinkType,
        tokenRelatedSeen: state.dashboardFilters.tokenRelatedSeen,
      }),
      (filters) => {
        persistStoredFilters(filters);
        if (currentView.value === 'token') {
          resetTablePage('tokenDirectory');
          scheduleCollectionReload('tokens');
        }
        if (currentView.value === 'dashboard' && state.dashboardTab === 'tokens') {
          resetTablePage('contractOverview');
          scheduleCollectionReload('contracts');
        }
        if (currentView.value === 'token-detail') {
          resetTablePage('tokenRelatedContracts');
        }
      },
      { deep: true },
    );

    watch(
      () => ({
        key: state.tableSorts.contractOverview.key,
        dir: state.tableSorts.contractOverview.dir,
        page: state.tablePages.contractOverview,
      }),
      () => {
        if (currentView.value === 'dashboard' && state.dashboardTab === 'tokens') {
          scheduleCollectionReload('contracts');
        }
      },
      { deep: true },
    );

    watch(
      () => ({
        key: state.tableSorts.tokenDirectory.key,
        dir: state.tableSorts.tokenDirectory.dir,
        page: state.tablePages.tokenDirectory,
      }),
      () => {
        if (currentView.value === 'token') {
          scheduleCollectionReload('tokens');
        }
      },
      { deep: true },
    );

    watch(
      () => routeToken.value,
      () => {
        resetTablePage('tokenRelatedContracts');
      },
    );

    watch(
      () => state.analysisForm.provider,
      (provider) => {
        const normalizedProvider = normalizeAiProvider(provider);
        if (state.analysisForm.provider !== normalizedProvider) {
          state.analysisForm.provider = normalizedProvider;
          return;
        }
        const normalizedModel = normalizeAiModel(normalizedProvider, state.analysisForm.model);
        if (state.analysisForm.model !== normalizedModel) {
          state.analysisForm.model = normalizedModel;
        }
      },
      { immediate: true },
    );

    watch(
      () => state.settings.runtime_settings.auto_analysis.provider,
      (provider) => {
        const normalizedProvider = normalizeAiProvider(provider);
        if (state.settings.runtime_settings.auto_analysis.provider !== normalizedProvider) {
          state.settings.runtime_settings.auto_analysis.provider = normalizedProvider;
          return;
        }
        const normalizedModel = normalizeAiModel(
          normalizedProvider,
          state.settings.runtime_settings.auto_analysis.model,
        );
        if (state.settings.runtime_settings.auto_analysis.model !== normalizedModel) {
          state.settings.runtime_settings.auto_analysis.model = normalizedModel;
        }
      },
      { immediate: true },
    );
  }

  window.EventFilterDashboardViewState = {
    installDashboardViewState,
  };
})();
