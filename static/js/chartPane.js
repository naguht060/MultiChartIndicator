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

const INDICATOR_CONFIGS = [
  { key: 'sma20', label: 'SMA 20', category: 'Moving Averages', color: '#facc15', scale: 'overlay' },
  { key: 'ema20', label: 'EMA 20', category: 'Moving Averages', color: '#fb923c', scale: 'overlay' },
  { key: 'sma50', label: 'SMA 50', category: 'Moving Averages', color: '#c084fc', scale: 'overlay' },
  { key: 'ema50', label: 'EMA 50', category: 'Moving Averages', color: '#fb7185', scale: 'overlay' },
  { key: 'bollinger', label: 'Bollinger Bands', category: 'Bands', color: '#7c3aed', scale: 'overlay' },
  { key: 'vwap', label: 'VWAP', category: 'Bands', color: '#22c55e', scale: 'overlay' },
  { key: 'keltner', label: 'Keltner Channels', category: 'Bands', color: '#38bdf8', scale: 'overlay' },
  { key: 'supertrend', label: 'Supertrend (10, 3)', category: 'Trend', color: '#a855f7', scale: 'overlay' },
  { key: 'ichimoku', label: 'Ichimoku Cloud', category: 'Trend', color: '#22d3ee', scale: 'overlay' },
  { key: 'pivot', label: 'Pivot Points', category: 'Price Action', color: '#60a5fa', scale: 'overlay' },
  { key: 'fair_value_gaps', label: 'Fair Value Gaps', category: 'Price Action', color: '#facc15', scale: 'overlay' },
  { key: 'volume_profile', label: 'Volume Profile (POC/VA)', category: 'Price Action', color: '#84cc16', scale: 'overlay' },
  { key: 'volume', label: 'Volume', category: 'Volume', color: '#64748b', scale: 'volume' },
  { key: 'rsi14', label: 'RSI (14)', category: 'Oscillators', color: '#8b5cf6', scale: 'indicator' },
  { key: 'macd', label: 'MACD (12, 26, 9)', category: 'Oscillators', color: '#22c55e', scale: 'indicator' },
  { key: 'stochastic', label: 'Stochastic (14, 3, 3)', category: 'Oscillators', color: '#fbbf24', scale: 'indicator' },
  { key: 'atr14', label: 'ATR (14)', category: 'Oscillators', color: '#60a5fa', scale: 'indicator' },
  { key: 'adx14', label: 'ADX (14)', category: 'Oscillators', color: '#ec4899', scale: 'indicator' },
  { key: 'cci20', label: 'CCI (20)', category: 'Oscillators', color: '#fb7185', scale: 'indicator' },
  { key: 'obv', label: 'OBV', category: 'Oscillators', color: '#38bdf8', scale: 'indicator' },
  { key: 'mfi14', label: 'MFI (14)', category: 'Oscillators', color: '#f97316', scale: 'indicator' },
  { key: 'williamsr', label: 'Williams %R', category: 'Oscillators', color: '#22c55e', scale: 'indicator' },
];

class ChartPane {
  /**
   * @param {HTMLElement} container  - The .chart-pane DOM element
   * @param {object}      symbols    - { crypto: string[], stocks: string[] }
   * @param {number}      paneIndex  - 0-based index (used for default symbol cycling)
   */
  constructor(container, symbols, paneIndex = 0, activeSource = 'yahoo_india') {
    this.container   = container;
    this.symbols     = symbols;
    this.paneIndex   = paneIndex;
    this.activeSource = activeSource;

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
    this.chart               = null;
    this.candleSeries        = null;
    this.volumeSeries        = null;
    this.indicatorSeriesMap  = {};
    this.currentSymbol       = null;
    this.currentInterval     = '5m';
    this.activeIndicators     = new Set();
    this.currentSource         = null;   // 'crypto' | 'stock'
    this._prevClose            = null;
    this._openPrice            = null;
    this._candles              = [];
    this._activeIndicatorKeys  = [];
    this._resizeObserver       = null;
    this._liveWS               = null;   // stock websocket
    this._hlCandleCb           = null;   // hyperliquid candle callback ref
    this._hlMidCb              = null;   // hyperliquid allMids callback ref
    this._flashTimer           = null;
    this._documentClickHandler = null;

    this._bindDOM();
    this._buildChart();
    this._populateSymbolDropdown();
    this._buildIndicatorPanel();
    this._attachEvents();

    // Choose default symbol cycling through the active source list
    const def = this._getDefaultSymbol();
    if (def) {
      this._loadSymbol(def, this.currentInterval);
    } else {
      this._setBadge('error');
      this._showOverlay(false);
    }
  }

  // ── DOM ────────────────────────────────────────────────────

  _bindDOM() {
    const c = this.container;
    this.tickerBar      = c.querySelector('.ticker-bar');
    this.tickerSymbol   = c.querySelector('.ticker-symbol');
    this.tickerExchange = c.querySelector('.ticker-exchange');
    this.tickerPrice    = c.querySelector('.ticker-price');
    this.tickerChange   = c.querySelector('.ticker-change');
    this.tickerBadge      = c.querySelector('.ticker-badge');
    this.symbolSelect     = c.querySelector('.symbol-select');
    this.tfSelect         = c.querySelector('.tf-select');
    this.sourceBadge      = c.querySelector('.source-badge');
    this.indicatorBtn     = c.querySelector('.indicator-btn');
    this.indicatorPanel   = c.querySelector('.indicator-panel');
    this.indicatorPanelInner = c.querySelector('.indicator-panel-inner');
    this.refreshBtn       = c.querySelector('.refresh-btn');
    this.chartContainer   = c.querySelector('.chart-container');
    this.overlay          = c.querySelector('.pane-overlay');
  }

  _populateSymbolDropdown() {
    const sel = this.symbolSelect;
    sel.innerHTML = '';

    const addGroup = (label, items) => {
      if (!items || items.length === 0) return;
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

    if (this.activeSource === 'hyperliquid') {
      addGroup('── Crypto (Hyperliquid)', this.symbols.crypto);
    } else if (this.activeSource === 'yahoo_us') {
      addGroup('── US Stocks (Yahoo)', this.symbols.usStocks);
    } else {
      addGroup('── Indian Stocks (NSE)', this.symbols.stocks);
    }
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
    this.indicatorBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      this._toggleIndicatorPanel();
    });
    this.indicatorPanel.addEventListener('click', (evt) => evt.stopPropagation());
    this._documentClickHandler = () => this._closeIndicatorPanel();
    document.addEventListener('click', this._documentClickHandler);
    this._refreshIndicatorButtonLabel();
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
    if (!symbol) {
      this._setBadge('error');
      this._showOverlay(false);
      return;
    }

    this._teardownLive();
    this.currentSymbol   = symbol;
    this.currentInterval = interval;
    this._prevClose      = null;
    this._openPrice      = null;

    // Sync UI
    this.symbolSelect.value = symbol;
    this.tfSelect.value = interval;
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
    if (!candles || candles.length === 0) {
      this._candles = [];
      this.candleSeries.setData([]);
      this.volumeSeries.setData([]);
      this._updateIndicatorSeries([]);
      return;
    }

    // Sort by time ascending (required by LW Charts)
    const sorted = [...candles].sort((a, b) => a.time - b.time);

    // Deduplicate by time
    const seen = new Set();
    const deduped = sorted.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    this._candles = deduped;

    this.candleSeries.setData(deduped.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));

    this._setVolumeVisibility(this.activeIndicators.has('volume'));
    this._updateIndicatorSeries(deduped);

    const last = deduped[deduped.length - 1];
    this._openPrice = deduped[0].close;
    this._updateTickerPrice(last.close, last);
    this.chart.timeScale().scrollToRealTime();
  }

  _updateCandle(bar) {
    try {
      const last = this._candles[this._candles.length - 1];
      if (!last || last.time < bar.time) {
        this._candles.push(bar);
      } else if (last.time === bar.time) {
        this._candles[this._candles.length - 1] = bar;
      }

      this.candleSeries.update({
        time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      });
      this._setVolumeVisibility(this.activeIndicators.has('volume'));
      this._updateIndicatorSeries(this._candles);
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

  _updateIndicatorSeries(candles) {
    this._clearActiveIndicatorSeries();
    if (!candles) return;

    this._setVolumeVisibility(this.activeIndicators.has('volume'));
    if (this.activeIndicators.size === 0) return;

    this.activeIndicators.forEach((indicator) => {
      if (indicator === 'volume') return;
      const datasets = this._indicatorDataSets(candles, indicator);
      datasets.forEach((dataset) => {
        const series = this._ensureIndicatorSeries(dataset.key, dataset.options);
        series.setData(dataset.data);
        this._activeIndicatorKeys.push(dataset.key);
      });
    });
  }

  _ensureIndicatorSeries(key, options) {
    if (this.indicatorSeriesMap[key]) return this.indicatorSeriesMap[key];
    const series = options.type === 'histogram'
      ? this.chart.addHistogramSeries(options)
      : this.chart.addLineSeries(options);
    this.indicatorSeriesMap[key] = series;
    return series;
  }

  _clearActiveIndicatorSeries() {
    if (!this._activeIndicatorKeys) {
      this._activeIndicatorKeys = [];
      return;
    }
    this._activeIndicatorKeys.forEach((key) => {
      const series = this.indicatorSeriesMap[key];
      if (series) series.setData([]);
    });
    this._activeIndicatorKeys.length = 0;
  }

  _indicatorDataSets(candles, indicator) {
    const closeSeries = candles.map(c => ({ time: c.time, value: c.close }));
    const overlayOptions = (opts) => ({ priceScaleId: 'overlay', ...opts });
    const indicatorOptions = (opts) => ({ priceScaleId: 'indicator', ...opts });
    switch (indicator) {
      case 'sma20':
      case 'sma50':
        return [{ key: indicator, data: this._simpleMovingAverage(closeSeries, indicator.endsWith('50') ? 50 : 20), options: overlayOptions({ color: '#facc15', lineWidth: 2 }) }];
      case 'ema20':
      case 'ema50':
        return [{ key: indicator, data: this._exponentialMovingAverage(closeSeries, indicator.endsWith('50') ? 50 : 20), options: overlayOptions({ color: '#fb923c', lineWidth: 2 }) }];
      case 'rsi14':
        return [{ key: 'rsi14', data: this._relativeStrengthIndex(closeSeries, 14), options: indicatorOptions({ color: '#38bdf8', lineWidth: 2 }) }];
      case 'macd': {
        const macd = this._macd(closeSeries, 12, 26, 9);
        return [
          { key: 'macd_line', data: macd.macd, options: indicatorOptions({ color: '#facc15', lineWidth: 2 }) },
          { key: 'macd_signal', data: macd.signal, options: indicatorOptions({ color: '#fb7185', lineWidth: 1 }) },
        ];
      }
      case 'bollinger': {
        const bb = this._bollingerBands(closeSeries, 20, 2);
        return [
          { key: 'bollinger_upper', data: bb.upper, options: overlayOptions({ color: '#7c3aed', lineWidth: 1, lineStyle: 2 }) },
          { key: 'bollinger_basis', data: bb.middle, options: overlayOptions({ color: '#f59e0b', lineWidth: 1, lineStyle: 1 }) },
          { key: 'bollinger_lower', data: bb.lower, options: overlayOptions({ color: '#7c3aed', lineWidth: 1, lineStyle: 2 }) },
        ];
      }
      case 'vwap':
        return [{ key: 'vwap', data: this._vwap(candles), options: overlayOptions({ color: '#22c55e', lineWidth: 2 }) }];
      case 'keltner': {
        const kc = this._keltnerChannels(candles, 20, 1.5);
        return [
          { key: 'keltner_upper', data: kc.upper, options: overlayOptions({ color: '#38bdf8', lineWidth: 1, lineStyle: 2 }) },
          { key: 'keltner_basis', data: kc.middle, options: overlayOptions({ color: '#f97316', lineWidth: 1, lineStyle: 1 }) },
          { key: 'keltner_lower', data: kc.lower, options: overlayOptions({ color: '#38bdf8', lineWidth: 1, lineStyle: 2 }) },
        ];
      }
      case 'supertrend':
        return [{ key: 'supertrend', data: this._supertrend(candles, 10, 3), options: overlayOptions({ color: '#ec4899', lineWidth: 2 }) }];
      case 'ichimoku': {
        const ich = this._ichimoku(candles);
        return [
          { key: 'ichimoku_tenkansen', data: ich.tenkan, options: overlayOptions({ color: '#22d3ee', lineWidth: 1 }) },
          { key: 'ichimoku_kijun', data: ich.kijun, options: overlayOptions({ color: '#a78bfa', lineWidth: 1 }) },
          { key: 'ichimoku_senkouA', data: ich.senkouA, options: overlayOptions({ color: '#4ade80', lineWidth: 1, lineStyle: 2 }) },
          { key: 'ichimoku_senkouB', data: ich.senkouB, options: overlayOptions({ color: '#f87171', lineWidth: 1, lineStyle: 2 }) },
        ];
      }
      case 'pivot': {
        const pivot = this._pivotPoints(candles);
        return [
          { key: 'pivot_line', data: pivot.pivot, options: overlayOptions({ color: '#fbbf24', lineWidth: 1, lineStyle: 1 }) },
          { key: 'pivot_r1', data: pivot.r1, options: overlayOptions({ color: '#38bdf8', lineWidth: 1, lineStyle: 2 }) },
          { key: 'pivot_s1', data: pivot.s1, options: overlayOptions({ color: '#fb7185', lineWidth: 1, lineStyle: 2 }) },
        ];
      }
      case 'fair_value_gaps':
        return [{ key: 'fair_value_gaps', data: this._fairValueGaps(candles), options: overlayOptions({ color: '#8b5cf6', lineWidth: 1, lineStyle: 2 }) }];
      case 'volume_profile':
        return [{ key: 'volume_profile', data: this._volumeProfile(candles), options: overlayOptions({ color: '#22c55e', lineWidth: 1, lineStyle: 2 }) }];
      case 'stochastic': {
        const stoch = this._stochastic(candles, 14, 3);
        return [
          { key: 'stoch_k', data: stoch.k, options: indicatorOptions({ color: '#22c55e', lineWidth: 1 }) },
          { key: 'stoch_d', data: stoch.d, options: indicatorOptions({ color: '#fb7185', lineWidth: 1 }) },
        ];
      }
      case 'atr14':
        return [{ key: 'atr14', data: this._averageTrueRange(candles, 14), options: indicatorOptions({ color: '#38bdf8', lineWidth: 1 }) }];
      case 'adx14':
        return [{ key: 'adx14', data: this._adx(candles, 14), options: indicatorOptions({ color: '#facc15', lineWidth: 1 }) }];
      case 'cci20':
        return [{ key: 'cci20', data: this._cci(candles, 20), options: indicatorOptions({ color: '#a78bfa', lineWidth: 1 }) }];
      case 'obv':
        return [{ key: 'obv', data: this._onBalanceVolume(candles), options: indicatorOptions({ color: '#34d399', lineWidth: 1 }) }];
      case 'mfi14':
        return [{ key: 'mfi14', data: this._moneyFlowIndex(candles, 14), options: indicatorOptions({ color: '#fb7185', lineWidth: 1 }) }];
      case 'williamsr':
        return [{ key: 'williamsr', data: this._williamsPercentR(candles, 14), options: indicatorOptions({ color: '#f97316', lineWidth: 1 }) }];
      default:
        return [];
    }
  }

  _computeIndicator(candles, indicator) {
    return [];
  }

  _simpleMovingAverage(data, period) {
    if (!data || data.length < period) return [];
    const result = [];
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i].value;
      if (i >= period) {
        sum -= data[i - period].value;
      }
      if (i >= period - 1) {
        result.push({ time: data[i].time, value: sum / period });
      }
    }
    return result;
  }

  _exponentialMovingAverage(data, period) {
    if (!data || data.length < period) return [];
    const result = [];
    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((sum, bar) => sum + bar.value, 0) / period;
    result.push({ time: data[period - 1].time, value: ema });
    for (let i = period; i < data.length; i++) {
      ema = (data[i].value - ema) * multiplier + ema;
      result.push({ time: data[i].time, value: ema });
    }
    return result;
  }

  _bollingerBands(data, period, multiplier) {
    if (!data || data.length < period) return { upper: [], middle: [], lower: [] };
    const middle = this._simpleMovingAverage(data, period);
    const upper = [];
    const lower = [];
    for (let i = 0; i < middle.length; i++) {
      const window = data.slice(i, i + period).map(item => item.value);
      const mean = middle[i].value;
      const variance = window.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / period;
      const stddev = Math.sqrt(variance);
      upper.push({ time: middle[i].time, value: mean + multiplier * stddev });
      lower.push({ time: middle[i].time, value: mean - multiplier * stddev });
    }
    return { upper, middle, lower };
  }

  _typicalPrice(bar) {
    return (bar.high + bar.low + bar.close) / 3;
  }

  _vwap(candles) {
    const data = [];
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    candles.forEach((bar) => {
      const tp = this._typicalPrice(bar);
      cumulativePV += tp * (bar.volume || 0);
      cumulativeVolume += bar.volume || 0;
      const value = cumulativeVolume ? cumulativePV / cumulativeVolume : tp;
      data.push({ time: bar.time, value });
    });
    return data;
  }

  _averageTrueRange(candles, period) {
    if (!candles || candles.length < period + 1) return [];
    const result = [];
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const trueRange = Math.max(
        current.high - current.low,
        Math.abs(current.high - prev.close),
        Math.abs(current.low - prev.close),
      );
      tr.push(trueRange);
    }
    let atr = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    result.push({ time: candles[period].time, value: atr });
    for (let i = period; i < tr.length; i++) {
      atr = (atr * (period - 1) + tr[i]) / period;
      result.push({ time: candles[i + 1].time, value: atr });
    }
    return result;
  }

  _adx(candles, period) {
    if (!candles || candles.length < period + 1) return [];
    const plusDM = [];
    const minusDM = [];
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const upMove = current.high - prev.high;
      const downMove = prev.low - current.low;
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
      tr.push(Math.max(
        current.high - current.low,
        Math.abs(current.high - prev.close),
        Math.abs(current.low - prev.close),
      ));
    }

    const atr = []; 
    let prevAtr = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    atr.push(prevAtr);
    for (let i = period; i < tr.length; i++) {
      prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
      atr.push(prevAtr);
    }

    const smoothPlus = [];
    const smoothMinus = [];
    let plusSum = plusDM.slice(0, period).reduce((sum, value) => sum + value, 0);
    let minusSum = minusDM.slice(0, period).reduce((sum, value) => sum + value, 0);
    smoothPlus.push(plusSum);
    smoothMinus.push(minusSum);
    for (let i = period; i < plusDM.length; i++) {
      plusSum = plusSum - (plusSum / period) + plusDM[i];
      minusSum = minusSum - (minusSum / period) + minusDM[i];
      smoothPlus.push(plusSum);
      smoothMinus.push(minusSum);
    }

    const dx = [];
    for (let i = 0; i < atr.length; i++) {
      const plusDI = atr[i] && smoothPlus[i] ? 100 * (smoothPlus[i] / period) / atr[i] : 0;
      const minusDI = atr[i] && smoothMinus[i] ? 100 * (smoothMinus[i] / period) / atr[i] : 0;
      const diff = Math.abs(plusDI - minusDI);
      const sum = plusDI + minusDI;
      dx.push(sum === 0 ? 0 : (100 * diff) / sum);
    }

    const adx = [];
    let prevAdx = dx.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    adx.push({ time: candles[period].time, value: prevAdx });
    for (let i = period; i < dx.length; i++) {
      prevAdx = (prevAdx * (period - 1) + dx[i]) / period;
      adx.push({ time: candles[i + 1].time, value: prevAdx });
    }
    return adx;
  }

  _cci(candles, period) {
    if (!candles || candles.length < period) return [];
    const result = [];
    for (let i = period - 1; i < candles.length; i++) {
      const slice = candles.slice(i - period + 1, i + 1);
      const typical = slice.map(bar => (bar.high + bar.low + bar.close) / 3);
      const mean = typical.reduce((sum, value) => sum + value, 0) / period;
      const meanDeviation = typical.reduce((sum, value) => sum + Math.abs(value - mean), 0) / period;
      const currentTp = typical[typical.length - 1];
      const value = meanDeviation === 0 ? 0 : (currentTp - mean) / (0.015 * meanDeviation);
      result.push({ time: candles[i].time, value });
    }
    return result;
  }

  _onBalanceVolume(candles) {
    if (!candles || candles.length === 0) return [];
    const result = [];
    let obv = 0;
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const current = candles[i];
      const volume = current.volume || 0;
      if (current.close > prev.close) obv += volume;
      else if (current.close < prev.close) obv -= volume;
      result.push({ time: current.time, value: obv });
    }
    return result;
  }

  _moneyFlowIndex(candles, period) {
    if (!candles || candles.length < period + 1) return [];
    const typical = candles.map(bar => (bar.high + bar.low + bar.close) / 3);
    const positiveFlow = [];
    const negativeFlow = [];
    for (let i = 1; i < candles.length; i++) {
      const rawFlow = typical[i] * (candles[i].volume || 0);
      if (typical[i] > typical[i - 1]) positiveFlow.push(rawFlow);
      else negativeFlow.push(rawFlow);
    }
    const result = [];
    for (let i = period; i < typical.length; i++) {
      const pos = positiveFlow.slice(i - period, i).reduce((sum, value) => sum + value, 0);
      const neg = negativeFlow.slice(i - period, i).reduce((sum, value) => sum + value, 0);
      const moneyRatio = neg === 0 ? 1 : pos / neg;
      const mfi = 100 - (100 / (1 + moneyRatio));
      result.push({ time: candles[i].time, value: mfi });
    }
    return result;
  }

  _williamsPercentR(candles, period) {
    if (!candles || candles.length < period) return [];
    const result = [];
    for (let i = period - 1; i < candles.length; i++) {
      const slice = candles.slice(i - period + 1, i + 1);
      const highestHigh = Math.max(...slice.map(bar => bar.high));
      const lowestLow = Math.min(...slice.map(bar => bar.low));
      const value = lowestLow === highestHigh ? -50 : ((highestHigh - candles[i].close) / (highestHigh - lowestLow)) * -100;
      result.push({ time: candles[i].time, value });
    }
    return result;
  }

  _keltnerChannels(candles, period, multiplier) {
    const typical = candles.map((bar) => ({ time: bar.time, value: this._typicalPrice(bar) }));
    const middle = this._exponentialMovingAverage(typical, period);
    const atr = this._averageTrueRange(candles, period);
    const upper = [];
    const lower = [];
    const atrByTime = new Map(atr.map(item => [item.time, item.value]));
    middle.forEach((item) => {
      const atrValue = atrByTime.get(item.time) || 0;
      upper.push({ time: item.time, value: item.value + multiplier * atrValue });
      lower.push({ time: item.time, value: item.value - multiplier * atrValue });
    });
    return { upper, middle, lower };
  }

  _relativeStrengthIndex(data, period) {
    if (!data || data.length < period + 1) return [];
    const gains = [];
    const losses = [];
    for (let i = 1; i < data.length; i++) {
      const change = data[i].value - data[i - 1].value;
      gains.push(Math.max(0, change));
      losses.push(Math.max(0, -change));
    }
    let avgGain = gains.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    const result = [];
    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      const value = 100 - 100 / (1 + rs);
      result.push({ time: data[i + 1].time, value });
    }
    return result;
  }

  _macd(data, fast, slow, signalPeriod) {
    if (!data || data.length < slow + signalPeriod) return { macd: [], signal: [] };
    const fastEma = this._exponentialMovingAverage(data, fast);
    const slowEma = this._exponentialMovingAverage(data, slow);
    const macd = [];
    const slowMap = new Map(slowEma.map(item => [item.time, item.value]));
    fastEma.forEach((item) => {
      const slowValue = slowMap.get(item.time);
      if (slowValue != null) {
        macd.push({ time: item.time, value: item.value - slowValue });
      }
    });
    const signal = this._exponentialMovingAverage(macd, signalPeriod);
    return { macd, signal };
  }

  _pivotPoints(candles) {
    const pivot = [];
    const r1 = [];
    const s1 = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const p = (prev.high + prev.low + prev.close) / 3;
      pivot.push({ time: candles[i].time, value: p });
      r1.push({ time: candles[i].time, value: 2 * p - prev.low });
      s1.push({ time: candles[i].time, value: 2 * p - prev.high });
    }
    return { pivot, r1, s1 };
  }

  _fairValueGaps(candles) {
    const gaps = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const current = candles[i];
      if (current.low > prev.high || current.high < prev.low) {
        gaps.push({ time: current.time, value: (current.high + current.low) / 2 });
      }
    }
    return gaps;
  }

  _volumeProfile(candles) {
    const bucket = new Map();
    candles.forEach((bar) => {
      const mid = Math.round(((bar.high + bar.low + bar.close) / 3) * 100) / 100;
      bucket.set(mid, (bucket.get(mid) || 0) + (bar.volume || 0));
    });
    const pocEntry = Array.from(bucket.entries()).sort((a, b) => b[1] - a[1])[0];
    if (!pocEntry) return [];
    const poc = pocEntry[0];
    return candles.map((bar) => ({ time: bar.time, value: poc }));
  }

  _stochastic(candles, kPeriod, dPeriod) {
    const kLine = [];
    for (let i = kPeriod - 1; i < candles.length; i++) {
      const slice = candles.slice(i - kPeriod + 1, i + 1);
      const highestHigh = Math.max(...slice.map(x => x.high));
      const lowestLow = Math.min(...slice.map(x => x.low));
      const value = highestHigh === lowestLow ? 50 : ((candles[i].close - lowestLow) / (highestHigh - lowestLow)) * 100;
      kLine.push({ time: candles[i].time, value });
    }
    const dLine = this._simpleMovingAverage(kLine, dPeriod);
    return { k: kLine, d: dLine };
  }

  _supertrend(candles, period, multiplier) {
    const atr = this._averageTrueRange(candles, period);
    const result = [];
    if (atr.length === 0) return result;
    const atrMap = new Map(atr.map(item => [item.time, item.value]));
    let trendUp = 0;
    let trendDown = 0;
    let finalTrend = true;
    for (let i = period; i < candles.length; i++) {
      const bar = candles[i];
      const previous = candles[i - 1];
      const atrValue = atrMap.get(bar.time) || 0;
      const middle = (bar.high + bar.low) / 2;
      const upperBand = middle + multiplier * atrValue;
      const lowerBand = middle - multiplier * atrValue;
      if (i === period) {
        trendUp = upperBand;
        trendDown = lowerBand;
      } else {
        trendUp = bar.close > trendUp ? Math.max(upperBand, trendUp) : upperBand;
        trendDown = bar.close < trendDown ? Math.min(lowerBand, trendDown) : lowerBand;
      }
      if (bar.close > trendDown) {
        finalTrend = true;
      } else if (bar.close < trendUp) {
        finalTrend = false;
      }
      result.push({ time: bar.time, value: finalTrend ? trendDown : trendUp });
    }
    return result;
  }

  _ichimoku(candles) {
    const tenkan = [];
    const kijun = [];
    const senkouA = [];
    const senkouB = [];
    for (let i = 0; i < candles.length; i++) {
      if (i >= 8) {
        const slice = candles.slice(i - 8, i + 1);
        const high = Math.max(...slice.map(x => x.high));
        const low = Math.min(...slice.map(x => x.low));
        tenkan.push({ time: candles[i].time, value: (high + low) / 2 });
      }
      if (i >= 25) {
        const slice = candles.slice(i - 25, i + 1);
        const high = Math.max(...slice.map(x => x.high));
        const low = Math.min(...slice.map(x => x.low));
        kijun.push({ time: candles[i].time, value: (high + low) / 2 });
      }
      if (i >= 25) {
        const prevTenkan = tenkan[tenkan.length - 1];
        const prevKijun = kijun[kijun.length - 1];
        if (prevTenkan && prevKijun) {
          senkouA.push({ time: candles[i].time, value: (prevTenkan.value + prevKijun.value) / 2 });
        }
      }
      if (i >= 51) {
        const slice = candles.slice(i - 51, i + 1);
        const high = Math.max(...slice.map(x => x.high));
        const low = Math.min(...slice.map(x => x.low));
        senkouB.push({ time: candles[i].time, value: (high + low) / 2 });
      }
    }
    return { tenkan, kijun, senkouA, senkouB };
  }

  _buildIndicatorPanel() {
    if (!this.indicatorPanelInner) return;
    this.indicatorPanelInner.innerHTML = '';
    // Search input
    const searchWrap = document.createElement('div');
    searchWrap.className = 'indicator-search-wrap';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'indicator-search';
    searchInput.placeholder = 'Search indicators...';
    searchInput.setAttribute('aria-label', 'Search indicators');
    searchWrap.appendChild(searchInput);
    this.indicatorPanelInner.appendChild(searchWrap);
    const groups = new Map();
    INDICATOR_CONFIGS.forEach((item) => {
      if (!groups.has(item.category)) groups.set(item.category, []);
      groups.get(item.category).push(item);
    });

    groups.forEach((items, category) => {
      const group = document.createElement('div');
      group.className = 'indicator-group';
      const heading = document.createElement('h4');
      heading.textContent = category;
      group.appendChild(heading);

      items.forEach((item) => {
        const label = document.createElement('label');
        label.className = 'indicator-option';
        label.setAttribute('data-key', item.key);
        label.setAttribute('data-label', item.label.toLowerCase());
        const swatch = document.createElement('span');
        swatch.className = 'indicator-swatch';
        swatch.style.backgroundColor = item.color;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = item.key;
        input.checked = this.activeIndicators.has(item.key);
        input.addEventListener('change', () => this._toggleIndicator(item.key, input.checked));
        const text = document.createElement('span');
        text.textContent = item.label;
        label.appendChild(swatch);
        label.appendChild(input);
        label.appendChild(text);
        group.appendChild(label);
      });
      this.indicatorPanelInner.appendChild(group);
    });

    // Filtering logic
    const applyFilter = (q) => {
      const query = (q || '').trim().toLowerCase();
      const opts = this.indicatorPanelInner.querySelectorAll('.indicator-option');
      opts.forEach((el) => {
        const label = el.getAttribute('data-label') || '';
        const key = el.getAttribute('data-key') || '';
        const show = query === '' || label.includes(query) || key.includes(query);
        el.classList.toggle('hidden', !show);
      });
    };

    searchInput.addEventListener('input', (e) => applyFilter(e.target.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.target.value = ''; applyFilter(''); e.target.blur(); }
    });
  }

  _applyIndicatorFilter(query) {
    if (!this.indicatorPanelInner) return;
    const q = (query || '').trim().toLowerCase();
    const opts = this.indicatorPanelInner.querySelectorAll('.indicator-option');
    opts.forEach((el) => {
      const label = el.getAttribute('data-label') || '';
      const key = el.getAttribute('data-key') || '';
      const show = q === '' || label.includes(q) || key.includes(q);
      el.classList.toggle('hidden', !show);
    });
  }

  _toggleIndicatorPanel() {
    const isVisible = this.indicatorPanel.classList.toggle('visible');
    this.indicatorPanel.setAttribute('aria-hidden', !isVisible);
  }

  _closeIndicatorPanel() {
    if (this.indicatorPanel && this.indicatorPanel.classList.contains('visible')) {
      this.indicatorPanel.classList.remove('visible');
      this.indicatorPanel.setAttribute('aria-hidden', 'true');
    }
  }

  _toggleIndicator(key, enabled) {
    if (enabled) this.activeIndicators.add(key);
    else this.activeIndicators.delete(key);
    this._refreshIndicatorButtonLabel();
    this._updateIndicatorSeries(this._candles);
  }

  _refreshIndicatorButtonLabel() {
    const count = this.activeIndicators.size;
    if (!this.indicatorBtn) return;
    if (count === 0) {
      this.indicatorBtn.textContent = 'INDICATORS';
    } else if (count === 1) {
      const id = [...this.activeIndicators][0];
      const config = INDICATOR_CONFIGS.find(item => item.key === id);
      this.indicatorBtn.textContent = config ? config.label : `${count} Indicator`;
    } else {
      this.indicatorBtn.textContent = `${count} Indicators`;
    }
  }

  _setVolumeVisibility(visible) {
    if (!this._candles || this._candles.length === 0) {
      this.volumeSeries.setData([]);
      return;
    }
    if (!visible) {
      this.volumeSeries.setData([]);
      return;
    }
    this.volumeSeries.setData(this._candles.map(c => ({
      time: c.time,
      value: c.volume || 0,
      color: c.close >= c.open ? '#10b98125' : '#ef444425',
    })));
  }

  _showOverlay(visible) {
    this.overlay.classList.toggle('visible', visible);
  }

  _getDefaultSymbol() {
    if (this.activeSource === 'hyperliquid') {
      return this.symbols.crypto?.[this.paneIndex % this.symbols.crypto.length] || '';
    }
    if (this.activeSource === 'yahoo_us') {
      return this.symbols.usStocks?.[this.paneIndex % this.symbols.usStocks.length] || '';
    }
    return this.symbols.stocks?.[this.paneIndex % this.symbols.stocks.length] || '';
  }

  // ── Cleanup ────────────────────────────────────────────────

  destroy() {
    this._teardownLive();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._documentClickHandler) {
      document.removeEventListener('click', this._documentClickHandler);
      this._documentClickHandler = null;
    }
    if (this.chart) { this.chart.remove(); this.chart = null; }
  }
}
