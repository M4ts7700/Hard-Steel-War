/* Anonymous visits only: no account data, cookies, full referrers or fingerprint. */
window.HSWVisitTracker = (() => {
  const KEY = 'hsw-visit-v1', WINDOW_MS = 30 * 60 * 1000;
  let started = false;
  function start(config) {
    if (started || location.hostname !== 'hswar.cz' || location.protocol !== 'https:' ||
        navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
    started = true;
    let visit;
    try { visit = JSON.parse(sessionStorage.getItem(KEY)); } catch {}
    const now = Date.now();
    if (!visit || !/^[0-9a-f-]{36}$/i.test(visit.id) || !Number.isFinite(visit.at) || now < visit.at || now - visit.at >= WINDOW_MS) {
      visit = { id: crypto.randomUUID(), at: now, sent: false };
    }
    const persist = () => { try { sessionStorage.setItem(KEY, JSON.stringify(visit)); } catch {} };
    persist();
    if (visit.sent) return;
    let source = 'direct';
    try {
      const host = new URL(document.referrer).hostname;
      if (host === location.hostname) source = 'internal';
      else if (/(^|\.)(google\.[a-z.]+|bing\.com|seznam\.cz|duckduckgo\.com|search\.yahoo\.com)$/.test(host)) source = 'search';
      else if (/(^|\.)(facebook\.com|instagram\.com|tiktok\.com|youtube\.com|discord\.com|t\.co)$/.test(host)) source = 'social';
      else source = 'other';
    } catch {}
    const payload = {
      visit_id: visit.id,
      visit_source: source,
      visit_device: matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop',
      visit_language: (navigator.language || '').toLowerCase().startsWith('cs') ? 'cs' : 'other'
    };
    let inFlight = false, attempts = 0;
    async function send() {
      if (visit.sent || inFlight || attempts >= 3 || navigator.onLine === false || document.visibilityState === 'hidden') return;
      inFlight = true;
      attempts++;
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(config.url + '/rest/v1/rpc/record_hsw_visit', {
          method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: controller.signal, credentials: 'omit'
        });
        if (response.ok) { visit.sent = true; persist(); }
        // A missing migration or denied access needs an administrator, not repeated requests.
        else if (response.status >= 400 && response.status < 500 && response.status !== 429) attempts = 3;
      } catch {} finally {
        clearTimeout(timeout);
        inFlight = false;
        if (!visit.sent && attempts < 3) setTimeout(send, attempts * 15000);
        if (visit.sent || attempts >= 3) {
          removeEventListener('online', send);
          document.removeEventListener('visibilitychange', send);
        }
      }
    }
    addEventListener('online', send);
    document.addEventListener('visibilitychange', send);
    void send();
  }
  return { start };
})();
