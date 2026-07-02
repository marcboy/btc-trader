# ₿ Apex BTC Auto-Trader & Monitor

A high-performance, real-time Bitcoin monitoring dashboard and automated algorithmic scalping bot. This application connects directly to live Bitcoin price feeds and executes trades automatically based on user-defined threshold targets (e.g. up or down by $10).

---

## 🚀 Getting Started

The project is designed to be **extremely lightweight and zero-install** for simulated trading, with an optional zero-dependency proxy for live trading.

### Option 1: Simulated Paper Trading (Zero Install)
1. Double-click [index.html](file:///Users/marcboyer/Projects/btc-trader/index.html) to open the dashboard in any modern web browser.
2. The live price feed will connect automatically.
3. Set your parameters (e.g. Strategy, $10 Trigger Threshold, and Trade Size).
4. Click **Start Bot** to begin automated simulated scalping!

### Option 2: Live Coinbase Advanced Trade (CORS-Bypassed Proxy)
1. Open your terminal and navigate to this folder.
2. Start the proxy server using pure Node.js (requires no package installs):
   ```bash
   node server.js
   ```
3. Open [index.html](file:///Users/marcboyer/Projects/btc-trader/index.html) in your browser.
4. Toggle **Execution Mode** to **Live Exchange (Coinbase API)**.
5. Click the **CORS Bypassed Setup** header to expand settings.
6. Enter your Coinbase API Key & Secret, then click **Save Config**.
7. Click **Start Bot** to execute real orders via Coinbase.

---

## 📈 Key Features

* **WebSocket Price Feed**: Fetches real-time price updates tick-by-tick directly from Coinbase's public WebSocket (`wss://ws-feed.exchange.coinbase.com`).
* **Visual Target Overlays**: Custom Chart.js canvas rendering showing dashed indicators for **BUY** and **SELL** price targets.
* **Dual Algorithmic Logic**:
  * **Swing Grid (Default)**: Buy low, Sell high. Buys when the price drops below the threshold, and sells when it goes up.
  * **Trend Following**: Buy breakout, Sell breakdown. Buys when the price rises, and sells when it falls.
* **Comprehensive Stats & Auditing**:
  * Tracks Average Cost Basis dynamically.
  * Calculates real-time net worth based on current holdings.
  * Computes realized PnL and bot win rates.
  * Exports trade logs to a CSV spreadsheet.
* **Dynamic Bot Feed Console**: Scrolling logger displaying step-by-step logic checks and trade executions.

---

## 🛠️ Project Structure

* [index.html](file:///Users/marcboyer/Projects/btc-trader/index.html) - Beautiful dashboard UI using semantic HTML5, Chart.js, and standard modular components.
* [styles.css](file:///Users/marcboyer/Projects/btc-trader/styles.css) - Premium CSS design utilizing a dark mode theme, glassmorphic card effects, vibrant action colors, and glowing micro-animations.
* [app.js](file:///Users/marcboyer/Projects/btc-trader/app.js) - Client-side state engine, WebSocket listener, trading strategy rules, CSV export, and chart renderings.
* [server.js](file:///Users/marcboyer/Projects/btc-trader/server.js) - Secure proxy server written in native Node.js that signs and proxies orders to Coinbase Advanced Trade, bypassing browser CORS blocks without external NPM packages.
