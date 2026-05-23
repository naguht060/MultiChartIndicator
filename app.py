"""
app.py — Flask Backend for MultiChartAnalysis
==============================================
Endpoints:
  GET  /                          → serves index.html
  GET  /api/candles               → historical OHLCV (yfinance)
  GET  /api/symbols               → symbol catalogue
  WS   /ws/stock                  → live price polling loop (yfinance → browser)
"""

import json
import logging
import time
import threading

from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from flask_sock import Sock

import data_source as ds

# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)
sock = Sock(app)

# ---------------------------------------------------------------------------
# REST — Historical candles
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/candles")
def api_candles():
    symbol   = request.args.get("symbol", "RELIANCE.NS")
    interval = request.args.get("interval", "5m")
    period   = request.args.get("period", None)

    candles = ds.get_stock_candles(symbol, interval, period)
    return jsonify(candles)


@app.route("/api/symbols")
def api_symbols():
    return jsonify(ds.get_available_symbols())


# ---------------------------------------------------------------------------
# WebSocket — Live stock tick streaming
# ---------------------------------------------------------------------------

@sock.route("/ws/stock")
def ws_stock(ws):
    """
    Browser connects with ?symbol=RELIANCE.NS
    Server polls yfinance every 5 s and pushes the latest 1-min candle.
    """
    symbol = request.args.get("symbol", "RELIANCE.NS")
    logger.info("WS stock connected: %s", symbol)

    last_time = None
    try:
        while True:
            bar = ds.get_latest_price_yfinance(symbol)
            if bar and bar["time"] != last_time:
                last_time = bar["time"]
                ws.send(json.dumps({"type": "tick", "data": bar}))

            # Use a short sleep; check if client is still connected
            time.sleep(5)
    except Exception as exc:
        logger.info("WS stock disconnected (%s): %s", symbol, exc)


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
