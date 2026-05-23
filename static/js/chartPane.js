/**
 * chartPane.js — ChartPane class
 * ================================
 * Manages a single chart pane: symbol/TF dropdowns, Lightweight Chart
 * instance, ticker bar, and live data subscriptions.
 *
 * Source detection:
 *   - Symbol ends in .NS or .BO  → Flask/yfinance backend
 *   - Anything else              → Hyperliquid WebSocket
 */

class ChartPane {
  /**
   * @param {HTMLElement} container  - The .chart-pane DOM element
   * @param {object}      symbols    - { crypto: string[], stocks: string[] }
   * @param {number}      paneIndex  - 0-based index (used for default symbol cycling)
   */
  constructor(container, symbols, paneIndex = 0) {
    this.container  = container;
    this.symbols    = symbols;
    this.paneIndex  = paneIndex;

    // DOM refs (filled in _bindDOM)
    this.tickerBar      = null;
    this.tickerSymbol   = null;
    this.tickerExchange = null;
    this.tickerPrice    = null;
    this.tickerChange   = null;
    this.tickerBadge    = null;
    this.symbolSelect   = null;
    this.tfSelect       = null;
    this.sourceBadge    = null;
    this.refreshBtn     = null;
    this.chartContainer = null;
    this.overlay        = null;

    // State
    this.chart       = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.currentSymbol    = null;
    this.currentInterval  = '5m';
    this.currentSource    = null;   // 'crypto' | 'stock'
    this._prevClose       = null;
    this._openPrice       = null;
    this._liveWS          = null;   // stock websocket
    this._hlCandleCb      = null;   // hyperliquid candle callback ref
    this._hlMidCb         = null;   // hyperliquid allMids callback ref
    this._flashTimer      = null;

    this._bindDOM();
    this._buildChart();
    this._populateSymbolDropdown();
    this._attachEvents();

    // Choose default symbol cycling through the list
    const allSymbols = [...symbols.crypto, ...symbols.stocks];
    const def = allSymbols[paneIndex % allSymbols.length] || 'BTC';
    this._loadSymbol(def, this.currentInterval);
  }

  // ── DOM ────────────────────────────────────────────────────

  _bindDOM() {
    const c = this.container;
    this.tickerBar      = c.querySelector('.ticker-bar');
    this.tickerSymbol   = c.querySelector('.ticker-symbol');
    this.tickerExchange = c.querySelector('.ticker-exchange');
    this.tickerPrice    = c.querySelector('.ticker-price');
    this.tickerChange   = c.querySelector('.ticker-change');
    this.tickerBadge    = c.querySelector('.ticker-badge');
    this.symbolSelect   = c.querySelector('.symbol-select');
    this.tfSelect       = c.querySelector('.tf-select');
    this.sourceBadge    = c.querySelector('.source-badge');
    this.refreshBtn     = c.querySelector('.refresh-btn');
    this.chartContainer = c.querySelector('.chart-container');
    this.overlay        = c.querySelector('.pane-overlay');
  }

  _populateSymbolDropdown() {
    const sel = this.symbolSelect;
    sel.innerHTML = '';

    const addGroup = (label, items) => {
      const grp = document.createElement('optgroup');
      grp.label = label;
      items.forEach(sym => {
        const opt = document.createElement('option');
        opt.value = sym;
        opt.textContent = sym;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    };

    addGroup('── Crypto (Hyperliquid)', this.symbols.crypto);
    addGroup('── Indian Stocks (NSE)', this.symbols.stocks);
  }

  // ── Chart ──────────────────────────────────────────────────

  _buildChart() {
    this.chart = LightweightCharts.createChart(this.chartContainer, {
      layout: {
        background: { type: 'solid', color: '#060b14' },
        textColor:  '#8ba3c7',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize:   11,
      },
      grid: {
        vertLines:  { color: '#111d30', style: 1 },
        horzLines:  { color: '#111d30', style: 1 },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine:  { color: '#3b82f6', width: 1, style: 2, labelBackgroundColor: '#1d4ed8' },
        horzLine:  { color: '#3b82f6', width: 1, style: 2, labelBackgroundColor: '#1d4ed8' },
      },
      rightPriceScale: {
        borderColor:   '#1e2d45',
        textColor:     '#8ba3c7',
        scaleMargins:  { top: 0.05, bottom: 0.2 },
      },
      timeScale: {
        borderColor:     '#1e2d45',
        timeVisible:     true,
        secondsVisible:  false,
        fixLeftEdge:     false,
        fixRightEdge:    false,
      },
      handleScroll:  { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
      handleScale:   { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    this.candleSeries = this.chart.addCandlestickSeries({
      upColor:         '#10b981',
      downColor:       '#ef4444',
      borderUpColor:   '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor:     '#10b981',
      wickDownColor:   '#ef4444',
    });

    // Volume series (histogram overlay)
    this.volumeSeries = this.chart.addHistogramSeries({
      priceFormat:    { type: 'volume' },
      priceScaleId:   'volume',
      color:          '#3b82f620',
    });
    this.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      borderVisible: false,
    });

    // Auto-resize on container resize
    this._resizeObserver = new ResizeObserver(() => this._fitChart());
    this._resizeObserver.observe(this.chartContainer);
  }

  _fitChart() {
    if (!this.chart) return;
    const { clientWidth: w, clientHeight: h } = this.chartContainer;
    if (w > 0 && h > 0) this.chart.resize(w, h);
  }

  // ── Events ─────────────────────────────────────────────────

  _attachEvents() {
    this.symbolSelect.addEventListener('change', () => {
      this._loadSymbol(this.symbolSelect.value, this.currentInterval);
    });
    this.tfSelect.addEventListener('change', () => {
      this.currentInterval = this.tfSelect.value;
      this._loadSymbol(this.currentSymbol, this.currentInterval);
    });
    this.refreshBtn.addEventListener('click', () => {
      this.refreshBtn.classList.add('spinning');
      this._loadSymbol(this.currentSymbol, this.currentInterval).finally(() => {
        setTimeout(() => this.refreshBtn.classList.remove('spinning'), 600);
      });
    });
  }

  // ── Source detection ───────────────────────────────────────

  _isCrypto(symbol) {
    return !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
  }

  // ── Main load flow ─────────────────────────────────────────

  async _loadSymbol(symbol, interval) {
    this._teardownLive();
    this.currentSymbol   = symbol;
    this.currentInterval = interval;
    this._prevClose      = null;
    this._openPrice      = null;

    // Sync UI
    this.symbolSelect.value = symbol;
    this.tfSelect.value     = interval;
    this._updateTickerLabel(symbol);
    this._showOverlay(true);
    this._setBadge('connecting');

    try {
      let candles = [];
      if (this._isCrypto(symbol)) {
        this.currentSource = 'crypto';
        candles = await HyperliquidWS.fetchHistory(symbol, interval);
      } else {
        this.currentSource = 'stock';
        candles = await this._fetchStockCandles(symbol, interval);
      }

      this._setChartData(candles);
      this._setupLive(symbol, interval);
      this._setBadge('live');
    } catch (err) {
      console.error('[Pane] load error:', err);
      this._setBadge('error');
    } finally {
      this._showOverlay(false);
    }
  }

  async _fetchStockCandles(symbol, interval) {
    const resp = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ── Chart data ─────────────────────────────────────────────

  _setChartData(candles) {
    if (!candles || candles.length === 0) return;

    // Sort by time ascending (required by LW Charts)
    const sorted = [...candles].sort((a, b) => a.time - b.time);

    // Deduplicate by time
    const seen = new Set();
    const deduped = sorted.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    this.candleSeries.setData(deduped.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));

    this.volumeSeries.setData(deduped.map(c => ({
      time:  c.time,
      value: c.volume || 0,
      color: c.close >= c.open ? '#10b98125' : '#ef444425',
    })));

    const last = deduped[deduped.length - 1];
    this._openPrice = deduped[0].close;
    this._updateTickerPrice(last.close, last);
    this.chart.timeScale().scrollToRealTime();
  }

  _updateCandle(bar) {
    try {
      this.candleSeries.update({
        time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      });
      this.volumeSeries.update({
        time: bar.time, value: bar.volume || 0,
        color: bar.close >= bar.open ? '#10b98125' : '#ef444425',
      });
      this._updateTickerPrice(bar.close, bar);
    } catch (e) {
      // Swallow out-of-order update errors silently
    }
  }

  // ── Live subscriptions ─────────────────────────────────────

  _setupLive(symbol, interval) {
    if (this._isCrypto(symbol)) {
      this._hlCandleCb = (bar) => this._updateCandle(bar);
      HyperliquidWS.subscribeCandle(symbol, interval, this._hlCandleCb);

      // Also subscribe to allMids for instant price updates
      this._hlMidCb = (mids) => {
        const price = mids[symbol];
        if (price != null) {
          this._flashTicker(parseFloat(price));
        }
      };
      HyperliquidWS.subscribeAllMids(this._hlMidCb);
    } else {
      this._connectStockWS(symbol);
    }
  }

  _connectStockWS(symbol) {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${location.host}/ws/stock?symbol=${encodeURIComponent(symbol)}`;
    const ws = new WebSocket(wsUrl);
    this._liveWS = ws;

    ws.onopen  = () => console.log(`[Pane ${this.paneIndex}] Stock WS open: ${symbol}`);
    ws.onerror = (e) => console.warn(`[Pane ${this.paneIndex}] Stock WS error:`, e);
    ws.onclose = () => {
      // Auto-reconnect after 6 s if still same symbol
      setTimeout(() => {
        if (this.currentSymbol === symbol && !this._isCrypto(symbol)) {
          this._connectStockWS(symbol);
        }
      }, 6000);
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'tick' && msg.data) {
          this._updateCandle(msg.data);
        }
      } catch (_) {}
    };
  }

  _teardownLive() {
    // Hyperliquid
    if (this._hlCandleCb && this.currentSymbol) {
      HyperliquidWS.unsubscribeCandle(this.currentSymbol, this.currentInterval, this._hlCandleCb);
      this._hlCandleCb = null;
    }
    if (this._hlMidCb) {
      HyperliquidWS.unsubscribeAllMids(this._hlMidCb);
      this._hlMidCb = null;
    }
    // Stock WS
    if (this._liveWS) {
      this._liveWS.onclose = null; // disable auto-reconnect
      this._liveWS.close();
      this._liveWS = null;
    }
  }

  // ── Ticker bar ─────────────────────────────────────────────

  _updateTickerLabel(symbol) {
    this.tickerSymbol.textContent = this._isCrypto(symbol)
      ? symbol + '/USDT'
      : symbol.replace(/\.(NS|BO)$/, '');
    this.tickerExchange.textContent = this._isCrypto(symbol)
      ? 'Hyperliquid'
      : symbol.endsWith('.NS') ? 'NSE' : 'BSE';

    const sb = this.sourceBadge;
    sb.textContent = this._isCrypto(symbol) ? 'CRYPTO' : 'STOCK';
    sb.className   = `source-badge pane-badge ${this._isCrypto(symbol) ? 'crypto' : 'stock'}`;
  }

  _updateTickerPrice(price, bar) {
    const prev = this._prevClose;
    this._flashTicker(price, prev);
    this._prevClose = price;

    this.tickerPrice.textContent = this._formatPrice(price);

    if (this._openPrice != null) {
      const chg     = price - this._openPrice;
      const chgPct  = (chg / this._openPrice) * 100;
      const sign    = chg >= 0 ? '+' : '';
      this.tickerChange.textContent = `${sign}${chg.toFixed(2)} (${sign}${chgPct.toFixed(2)}%)`;
      this.tickerChange.className   = `ticker-change ${chg >= 0 ? 'up' : 'down'}`;
    }
  }

  _flashTicker(price, prev) {
    if (prev === null || prev === undefined) return;
    const dir = price > prev ? 'flash-up' : price < prev ? 'flash-down' : null;
    if (!dir) return;

    // Clear any running flash
    if (this._flashTimer) { clearTimeout(this._flashTimer); }
    this.tickerBar.classList.remove('flash-up', 'flash-down');
    // Force reflow so animation restarts
    void this.tickerBar.offsetWidth;
    this.tickerBar.classList.add(dir);
    this._flashTimer = setTimeout(() => this.tickerBar.classList.remove(dir), 700);

    // Colour the price text momentarily
    this.tickerPrice.style.color = price > prev ? '#10b981' : '#ef4444';
    setTimeout(() => { this.tickerPrice.style.color = ''; }, 500);
  }

  _formatPrice(price) {
    if (price >= 1000)  return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (price >= 1)     return price.toFixed(4);
    return price.toFixed(6);
  }

  _setBadge(state) {
    const badge = this.tickerBadge;
    badge.classList.remove('connecting', 'error');
    if (state === 'live')        { badge.textContent = 'LIVE'; }
    else if (state === 'connecting') { badge.textContent = 'LOAD'; badge.classList.add('connecting'); }
    else if (state === 'error')  { badge.textContent = 'ERR';  badge.classList.add('error'); }
  }

  _showOverlay(visible) {
    this.overlay.classList.toggle('visible', visible);
  }

  // ── Cleanup ────────────────────────────────────────────────

  destroy() {
    this._teardownLive();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.chart) { this.chart.remove(); this.chart = null; }
  }
}
