/**
 * hyperliquid.js — Singleton WebSocket Manager for Hyperliquid
 * =============================================================
 * Maintains ONE WebSocket connection to wss://api.hyperliquid.xyz/ws
 * and fans out candle/trade/allMids data to all registered listeners.
 *
 * Usage:
 *   HyperliquidWS.subscribeCandle('BTC', '5m', (bar) => { ... });
 *   HyperliquidWS.unsubscribeCandle('BTC', '5m', callback);
 *   HyperliquidWS.subscribeAllMids((mids) => { ... });
 */

const HyperliquidWS = (() => {
  const WS_URL = 'wss://api.hyperliquid.xyz/ws';

  let _ws = null;
  let _reconnectDelay = 1000;   // ms, doubles on each failure
  let _reconnectTimer = null;
  let _pingTimer = null;

  // Listener registries
  // key: `${coin}:${interval}` → Set<callback(bar)>
  const _candleListeners = new Map();
  // Set<callback(mids)>
  const _midListeners = new Set();

  // Global status callbacks
  const _statusCallbacks = new Set();

  // ── Internal helpers ──────────────────────────────────────

  function _notifyStatus(status) {
    _statusCallbacks.forEach(cb => { try { cb(status); } catch (_) {} });
  }

  function _send(obj) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(obj));
    }
  }

  function _subscribe(type, extra = {}) {
    _send({ method: 'subscribe', subscription: { type, ...extra } });
  }

  function _resubscribeAll() {
    // Re-send all subscriptions after reconnect
    for (const key of _candleListeners.keys()) {
      const [coin, interval] = key.split(':');
      if (_candleListeners.get(key).size > 0) {
        _subscribe('candle', { coin, interval });
      }
    }
    if (_midListeners.size > 0) {
      _subscribe('allMids');
    }
  }

  function _startPing() {
    _pingTimer = setInterval(() => {
      _send({ method: 'ping' });
    }, 20000);
  }

  function _stopPing() {
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  }

  function _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    const channel = msg.channel;

    if (channel === 'candle') {
      // msg.data = { s: coin, i: interval, t, o, h, l, c, v, ... }
      const d = msg.data;
      if (!d) return;
      const key = `${d.s}:${d.i}`;
      const set = _candleListeners.get(key);
      if (set) {
        const bar = {
          time:   Math.floor(d.t / 1000),  // convert ms → seconds
          open:   parseFloat(d.o),
          high:   parseFloat(d.h),
          low:    parseFloat(d.l),
          close:  parseFloat(d.c),
          volume: parseFloat(d.v),
        };
        set.forEach(cb => { try { cb(bar); } catch (_) {} });
      }
    } else if (channel === 'allMids') {
      const mids = msg.data && msg.data.mids;
      if (mids) {
        _midListeners.forEach(cb => { try { cb(mids); } catch (_) {} });
      }
    }
    // Ignore pong, error, etc.
  }

  // ── Connection lifecycle ───────────────────────────────────

  function connect() {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    _notifyStatus('connecting');

    try {
      _ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('[HL] WebSocket construction failed:', e);
      _scheduleReconnect();
      return;
    }

    _ws.onopen = () => {
      console.log('[HL] Connected');
      _reconnectDelay = 1000;
      _notifyStatus('live');
      _startPing();
      _resubscribeAll();
    };

    _ws.onmessage = (evt) => _handleMessage(evt.data);

    _ws.onerror = (err) => {
      console.warn('[HL] WebSocket error:', err);
    };

    _ws.onclose = (evt) => {
      console.warn('[HL] Connection closed:', evt.code, evt.reason);
      _stopPing();
      _notifyStatus('disconnected');
      _scheduleReconnect();
    };
  }

  function _scheduleReconnect() {
    if (_reconnectTimer) return;
    console.log(`[HL] Reconnecting in ${_reconnectDelay}ms…`);
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      _reconnectDelay = Math.min(_reconnectDelay * 2, 30000);
      connect();
    }, _reconnectDelay);
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Subscribe to candlestick updates for a given coin + interval.
   * @param {string} coin     e.g. "BTC"
   * @param {string} interval e.g. "5m"
   * @param {Function} cb     called with { time, open, high, low, close, volume }
   */
  function subscribeCandle(coin, interval, cb) {
    const key = `${coin}:${interval}`;
    if (!_candleListeners.has(key)) {
      _candleListeners.set(key, new Set());
    }
    const set = _candleListeners.get(key);
    const wasEmpty = set.size === 0;
    set.add(cb);
    if (wasEmpty) {
      _subscribe('candle', { coin, interval });
    }
  }

  /**
   * Unsubscribe a specific callback from candle updates.
   */
  function unsubscribeCandle(coin, interval, cb) {
    const key = `${coin}:${interval}`;
    const set = _candleListeners.get(key);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) {
      _send({ method: 'unsubscribe', subscription: { type: 'candle', coin, interval } });
      _candleListeners.delete(key);
    }
  }

  /**
   * Subscribe to allMids (all mid prices snapshot, updated frequently).
   */
  function subscribeAllMids(cb) {
    const wasEmpty = _midListeners.size === 0;
    _midListeners.add(cb);
    if (wasEmpty) { _subscribe('allMids'); }
  }

  function unsubscribeAllMids(cb) {
    _midListeners.delete(cb);
    if (_midListeners.size === 0) {
      _send({ method: 'unsubscribe', subscription: { type: 'allMids' } });
    }
  }

  /** Register a callback to receive status strings: 'connecting' | 'live' | 'disconnected' */
  function onStatus(cb) { _statusCallbacks.add(cb); }
  function offStatus(cb) { _statusCallbacks.delete(cb); }

  /**
   * Fetch historical candles via Hyperliquid REST API.
   * Returns an array of { time, open, high, low, close, volume }
   */
  async function fetchHistory(coin, interval, startTime, endTime) {
    const INTERVAL_MAP = {
      '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
      '1h': '1h', '4h': '4h', '1d': '1d', '1wk': '1w',
    };
    const hlInterval = INTERVAL_MAP[interval] || interval;

    // Default: fetch last 200 candles
    const now = endTime || Date.now();
    const DURATION_MS = {
      '1m': 200 * 60e3,  '5m': 200 * 5 * 60e3, '15m': 200 * 15 * 60e3,
      '30m': 200 * 30 * 60e3, '1h': 200 * 3600e3, '4h': 200 * 4 * 3600e3,
      '1d': 200 * 86400e3, '1wk': 200 * 7 * 86400e3,
    };
    const start = startTime || (now - (DURATION_MS[interval] || 200 * 60e3));

    try {
      const resp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval: hlInterval, startTime: start, endTime: now },
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      return raw.map(d => ({
        time:   Math.floor(d.t / 1000),
        open:   parseFloat(d.o),
        high:   parseFloat(d.h),
        low:    parseFloat(d.l),
        close:  parseFloat(d.c),
        volume: parseFloat(d.v),
      }));
    } catch (e) {
      console.error('[HL] fetchHistory error:', e);
      return [];
    }
  }

  // Kick off the connection immediately
  connect();

  return {
    connect,
    subscribeCandle,
    unsubscribeCandle,
    subscribeAllMids,
    unsubscribeAllMids,
    fetchHistory,
    onStatus,
    offStatus,
  };
})();
