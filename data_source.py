"""
data_source.py — Pluggable Data Source Layer
=============================================
To add a new broker, implement a function with this signature:

    def get_<broker>_candles(symbol: str, interval: str, period: str) -> list[dict]:
        ...
        # Must return a list of dicts with keys:
        # { "time": int (unix seconds), "open": float, "high": float,
        #   "low": float, "close": float, "volume": float }

Then wire it up in get_stock_candles() below by checking the symbol or
passing a `source` parameter from the frontend.

Current active source: yfinance (Yahoo Finance) for NSE/BSE Indian stocks.
"""

import logging
import time
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Symbol catalogue (displayed in each pane's dropdown)
# ---------------------------------------------------------------------------

CRYPTO_SYMBOLS = [
    "BTC", "ETH", "SOL", "AVAX", "DOGE", "BNB", "ARB",
    "OP", "SUI", "APT", "INJ", "TIA", "ATOM", "MATIC", "LINK",
]

STOCK_SYMBOLS = [
    "RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS", "ICICIBANK.NS",
    "WIPRO.NS", "SBIN.NS", "AXISBANK.NS", "BHARTIARTL.NS", "LT.NS",
    "MARUTI.NS", "BAJFINANCE.NS", "ASIANPAINT.NS", "NESTLEIND.NS",
    "TITAN.NS", "HCLTECH.NS", "POWERGRID.NS", "NTPC.NS", "ONGC.NS",
    "COALINDIA.NS",
]

# Timeframe config: yfinance interval → best period to fetch
YFINANCE_PERIOD_MAP = {
    "1m":  ("1m",  "1d"),
    "5m":  ("5m",  "5d"),
    "15m": ("15m", "5d"),
    "30m": ("30m", "5d"),
    "1h":  ("60m", "60d"),
    "4h":  ("1h",  "60d"),   # aggregated to 4h on server
    "1d":  ("1d",  "1y"),
    "1wk": ("1wk", "5y"),
}


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _df_to_candles(df: pd.DataFrame) -> list[dict]:
    """Convert a yfinance OHLCV DataFrame to Lightweight Charts candle format."""
    candles = []
    for ts, row in df.iterrows():
        # ts may be timezone-aware; normalise to UTC unix seconds
        if hasattr(ts, "timestamp"):
            t = int(ts.timestamp())
        else:
            t = int(pd.Timestamp(ts).timestamp())

        o = float(row["Open"])
        h = float(row["High"])
        lo = float(row["Low"])
        c = float(row["Close"])
        v = float(row.get("Volume", 0))

        if any(pd.isna(x) for x in [o, h, lo, c]):
            continue

        candles.append({
            "time": t,
            "open": round(o, 4),
            "high": round(h, 4),
            "low":  round(lo, 4),
            "close": round(c, 4),
            "volume": round(v, 2),
        })
    return candles


def _aggregate_to_4h(candles_1h: list[dict]) -> list[dict]:
    """Aggregate 1h candles into 4h candles."""
    if not candles_1h:
        return []
    result = []
    bucket: list[dict] = []
    for c in candles_1h:
        bucket.append(c)
        # 4 bars per bucket
        if len(bucket) == 4:
            result.append({
                "time":   bucket[0]["time"],
                "open":   bucket[0]["open"],
                "high":   max(b["high"] for b in bucket),
                "low":    min(b["low"] for b in bucket),
                "close":  bucket[-1]["close"],
                "volume": sum(b["volume"] for b in bucket),
            })
            bucket = []
    # partial bucket at end
    if bucket:
        result.append({
            "time":   bucket[0]["time"],
            "open":   bucket[0]["open"],
            "high":   max(b["high"] for b in bucket),
            "low":    min(b["low"] for b in bucket),
            "close":  bucket[-1]["close"],
            "volume": sum(b["volume"] for b in bucket),
        })
    return result


# ---------------------------------------------------------------------------
# ✅ ACTIVE SOURCE — yfinance (Yahoo Finance)
# ---------------------------------------------------------------------------

def get_yfinance_candles(symbol: str, interval: str, period: str = None) -> list[dict]:
    """
    Fetch OHLCV candles from Yahoo Finance (yfinance).

    Parameters
    ----------
    symbol   : Ticker string, e.g. "RELIANCE.NS", "TCS.NS"
    interval : One of 1m | 5m | 15m | 30m | 1h | 4h | 1d | 1wk
    period   : Optional override; if None, chosen automatically from YFINANCE_PERIOD_MAP

    Returns
    -------
    list[dict] with keys: time (unix sec), open, high, low, close, volume
    """
    need_4h = (interval == "4h")
    yf_interval, yf_period = YFINANCE_PERIOD_MAP.get(interval, ("1d", "1y"))
    if period:
        yf_period = period

    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(period=yf_period, interval=yf_interval)
        if df.empty:
            logger.warning("yfinance returned empty data for %s %s", symbol, interval)
            return []
        candles = _df_to_candles(df)
        if need_4h:
            candles = _aggregate_to_4h(candles)
        return candles
    except Exception as exc:
        logger.error("yfinance error for %s: %s", symbol, exc)
        return []


def get_latest_price_yfinance(symbol: str) -> dict | None:
    """Return the latest OHLCV bar for a symbol (used for live polling)."""
    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(period="1d", interval="1m")
        if df.empty:
            return None
        row = df.iloc[-1]
        ts = df.index[-1]
        t = int(ts.timestamp()) if hasattr(ts, "timestamp") else int(pd.Timestamp(ts).timestamp())
        return {
            "time":   t,
            "open":   round(float(row["Open"]), 4),
            "high":   round(float(row["High"]), 4),
            "low":    round(float(row["Low"]), 4),
            "close":  round(float(row["Close"]), 4),
            "volume": round(float(row.get("Volume", 0)), 2),
        }
    except Exception as exc:
        logger.error("yfinance latest price error for %s: %s", symbol, exc)
        return None


# ---------------------------------------------------------------------------
# 🔌 STUB — Alpaca (swap in by replacing get_stock_candles below)
# ---------------------------------------------------------------------------

def get_alpaca_candles(symbol: str, interval: str, period: str = None) -> list[dict]:
    """
    Stub: fetch OHLCV from Alpaca Markets API.
    Install: pip install alpaca-trade-api
    Set env vars: ALPACA_KEY, ALPACA_SECRET
    """
    raise NotImplementedError(
        "Alpaca source not wired. Set ALPACA_KEY/ALPACA_SECRET and implement this function."
    )


# ---------------------------------------------------------------------------
# 🔌 STUB — Binance (swap in by replacing get_stock_candles below)
# ---------------------------------------------------------------------------

def get_binance_candles(symbol: str, interval: str, period: str = None) -> list[dict]:
    """
    Stub: fetch OHLCV from Binance REST API.
    Install: pip install python-binance
    """
    raise NotImplementedError("Binance source not wired. Implement using python-binance.")


# ---------------------------------------------------------------------------
# 🔌 STUB — Zerodha Kite (swap in by replacing get_stock_candles below)
# ---------------------------------------------------------------------------

def get_zerodha_candles(symbol: str, interval: str, period: str = None) -> list[dict]:
    """
    Stub: fetch OHLCV from Zerodha Kite Connect API.
    Install: pip install kiteconnect
    Requires Kite API key + access token.
    """
    raise NotImplementedError("Zerodha source not wired. Implement using kiteconnect.")


# ---------------------------------------------------------------------------
# 🔌 STUB — Polygon.io (swap in by replacing get_stock_candles below)
# ---------------------------------------------------------------------------

def get_polygon_candles(symbol: str, interval: str, period: str = None) -> list[dict]:
    """
    Stub: fetch OHLCV from Polygon.io REST API.
    Install: pip install polygon-api-client
    Set env var: POLYGON_KEY
    """
    raise NotImplementedError("Polygon source not wired. Set POLYGON_KEY and implement.")


# ---------------------------------------------------------------------------
# 🎯 MAIN ENTRY POINT — change ONE line here to swap broker
# ---------------------------------------------------------------------------

def get_stock_candles(symbol: str, interval: str, period: str = None) -> list[dict]:
    """
    Primary entry point called by app.py.

    To switch brokers, replace the call below:
        return get_yfinance_candles(...)   ← current
        return get_alpaca_candles(...)     ← Alpaca
        return get_zerodha_candles(...)    ← Zerodha
        return get_polygon_candles(...)    ← Polygon
    """
    return get_yfinance_candles(symbol, interval, period)


def get_available_symbols() -> dict:
    """Return the full symbol catalogue for both asset classes."""
    return {
        "crypto": CRYPTO_SYMBOLS,
        "stocks": STOCK_SYMBOLS,
    }
