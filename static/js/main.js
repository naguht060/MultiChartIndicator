/**
 * main.js — App Bootstrap & Grid Manager
 * ========================================
 * Handles:
 *  - Fetching symbol catalogue from /api/symbols
 *  - Reading/writing chart count to localStorage
 *  - Building & rebuilding the chart grid on count change
 *  - Wiring the segmented chart-count selector
 *  - Status bar (Hyperliquid WS status + live clock)
 */

(async () => {
  // ── Config ────────────────────────────────────────────────
  const STORAGE_KEY   = 'mca_chartCount';
  const DEFAULT_COUNT = 4;
  const VALID_COUNTS  = [1, 2, 4, 6, 8];

  // ── DOM refs ─────────────────────────────────────────────
  const grid       = document.getElementById('chart-grid');
  const sourceSelect = document.getElementById('data-source-select');
  const segBtns    = document.querySelectorAll('.seg-btn');
  const statusDot  = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const clockEl    = document.getElementById('clock');

  // ── State ─────────────────────────────────────────────────
  let panes       = [];   // Array of ChartPane instances
  let symbols     = { crypto: [], stocks: [], usStocks: [] };
  let chartCount  = DEFAULT_COUNT;
  let dataSource  = 'yahoo_india';

  // ── Symbol fetch ──────────────────────────────────────────
  try {
    const resp = await fetch('/api/symbols');
    if (resp.ok) symbols = await resp.json();
  } catch (e) {
    console.warn('[main] Could not fetch symbols; symbol lists will remain empty');
    symbols = {
      crypto: [],
      stocks: [],
      usStocks: [],
    };
  }

  // ── Restore saved count ───────────────────────────────────
  const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (VALID_COUNTS.includes(saved)) chartCount = saved;
  const savedSource = localStorage.getItem('mca_dataSource');
  if (['hyperliquid', 'yahoo_us', 'yahoo_india'].includes(savedSource)) dataSource = savedSource;
  sourceSelect.value = dataSource;

  // ── Grid builder ──────────────────────────────────────────

  function buildGrid(count, source) {
    // Destroy existing panes
    panes.forEach(p => p.destroy());
    panes = [];
    grid.innerHTML = '';
    grid.setAttribute('data-count', count);

    const template = document.getElementById('pane-template');

    for (let i = 0; i < count; i++) {
      // Clone pane from template
      const clone = template.content.cloneNode(true);
      const paneEl = clone.querySelector('.chart-pane');

      // Give each pane & its controls unique IDs for accessibility
      const uid = `pane-${i}`;
      paneEl.id = uid;
      paneEl.setAttribute('aria-label', `Chart pane ${i + 1}`);
      paneEl.querySelector('.symbol-select').id = `${uid}-symbol`;
      paneEl.querySelector('.tf-select').id = `${uid}-tf`;
      paneEl.querySelector('.refresh-btn').id = `${uid}-refresh`;

      // Stagger animation
      paneEl.style.animationDelay = `${i * 40}ms`;

      grid.appendChild(paneEl);

      // Create ChartPane instance for the now-attached element
      const pane = new ChartPane(paneEl, symbols, i, source);
      panes.push(pane);
    }
  }

  // ── Segmented control ─────────────────────────────────────

  function setActiveCount(count) {
    chartCount = count;
    localStorage.setItem(STORAGE_KEY, count);

    segBtns.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.count, 10) === count);
    });

    buildGrid(count, dataSource);
  }

  sourceSelect.addEventListener('change', () => {
    dataSource = sourceSelect.value;
    localStorage.setItem('mca_dataSource', dataSource);
    buildGrid(chartCount, dataSource);
  });

  segBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.count, 10);
      if (n !== chartCount) setActiveCount(n);
    });
  });

  // ── Hyperliquid status ────────────────────────────────────

  HyperliquidWS.onStatus(status => {
    if (status === 'live') {
      statusDot.className  = 'status-dot live';
      statusText.textContent = 'Live';
    } else if (status === 'connecting') {
      statusDot.className  = 'status-dot';
      statusText.textContent = 'Connecting…';
    } else {
      statusDot.className  = 'status-dot error';
      statusText.textContent = 'Reconnecting…';
    }
  });

  // ── Live clock ────────────────────────────────────────────

  function updateClock() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Kolkata',
    }) + ' IST';
  }
  updateClock();
  setInterval(updateClock, 1000);

  // ── Initial render ────────────────────────────────────────
  setActiveCount(chartCount);
})();
