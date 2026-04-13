(() => {
  function setBoundedMapEntry(map, key, value, maxEntries) {
    if (!(map instanceof Map)) return;
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 0;
    if (!limit) return;
    while (map.size > limit) {
      const oldestKey = map.keys().next().value;
      if (oldestKey == null) break;
      map.delete(oldestKey);
    }
  }

  function setTimedCacheEntry(map, key, payload, maxEntries) {
    setBoundedMapEntry(map, key, {
      payload,
      cachedAt: Date.now(),
    }, maxEntries);
  }

  function getFreshCacheEntry(map, key, ttlMs) {
    const entry = map.get(key);
    if (!entry || typeof entry !== 'object') return null;
    if (!Number.isFinite(entry.cachedAt) || (Date.now() - entry.cachedAt) > ttlMs) {
      map.delete(key);
      return null;
    }
    return entry.payload;
  }

  function createToastController(notifications, options = {}) {
    const maxVisible = Number.isFinite(options.maxVisible) ? Math.max(1, Math.floor(options.maxVisible)) : 4;
    const defaultDurationMs = Number.isFinite(options.defaultDurationMs) ? Math.max(0, Math.floor(options.defaultDurationMs)) : 3600;
    const timer = typeof options.timer === 'function' ? options.timer : window.setTimeout.bind(window);
    let notificationId = 0;

    function dismissNotification(id) {
      const index = notifications.findIndex((entry) => entry.id === id);
      if (index >= 0) notifications.splice(index, 1);
    }

    function pushNotification(message, tone = 'info', durationMs = defaultDurationMs) {
      const text = String(message || '').trim();
      if (!text) return;
      const id = ++notificationId;
      notifications.push({ id, message: text, tone });
      while (notifications.length > maxVisible) {
        notifications.shift();
      }
      if (durationMs > 0) {
        timer(() => dismissNotification(id), durationMs);
      }
    }

    return {
      dismissNotification,
      pushNotification,
    };
  }

  window.EventFilterDashboardRuntime = {
    setBoundedMapEntry,
    setTimedCacheEntry,
    getFreshCacheEntry,
    createToastController,
  };
})();
