/* app.js */

// Global Dashboard State (Synced from Server)
let state = {
  isRunning: false,
  mode: 'simulated',
  strategy: 'swing',
  threshold: 10,
  tradeAmount: 100,
  
  simPortfolio: {
    usd: 10000,
    btc: 0,
    avgBuyPrice: 0,
    totalInvested: 0,
    activePositionId: null
  },
  
  currentPrice: null,
  referencePrice: null,
  buyTargetPrice: null,
  sellTargetPrice: null,
  
  priceHistory: [],
  tradeLog: [],
  
  apiConfig: {
    apiKey: '',
    apiSecret: ''
  }
};

// Chart Instance
let priceChart = null;

// Session Management State
let sessionState = {
  currentSessionId: null,
  sessions: []
};

// Polling interval reference
let pollStateTimer = null;

// Helper to determine active backend API URL
function getApiUrl() {
  const customUrl = localStorage.getItem('apex_backend_api_url');
  if (customUrl) {
    return customUrl.replace(/\/$/, ''); // Remove trailing slash if present
  }
  
  if (window.location.origin.startsWith('file://') || window.location.origin === 'null') {
    return 'http://localhost:3000';
  }
  return window.location.origin;
}

// Initialize Dashboard Application
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  initSessionOverlay();
  setupEventListeners();
  
  // Start polling server state
  startStatePolling();
});

// Start Polling server dashboard state
function startStatePolling() {
  if (pollStateTimer) clearInterval(pollStateTimer);
  
  // Poll immediately, then every 1.5 seconds
  fetchServerState();
  pollStateTimer = setInterval(fetchServerState, 1500);
}

// Fetch dashboard state from server API
async function fetchServerState() {
  if (!sessionState.currentSessionId) return;
  
  try {
    const res = await fetch(`${getApiUrl()}/api/dashboard-state?sessionId=${sessionState.currentSessionId}`);
    if (res.ok) {
      const data = await res.json();
      
      // Update global state object
      const oldPrice = state.currentPrice;
      state.currentPrice = data.currentPrice;
      state.priceHistory = data.priceHistory || [];
      
      const s = data.session;
      state.isRunning = s.isRunning;
      state.mode = s.mode;
      state.strategy = s.strategy;
      state.threshold = s.threshold;
      state.tradeAmount = s.tradeAmount;
      state.referencePrice = s.referencePrice;
      state.buyTargetPrice = s.buyTargetPrice;
      state.sellTargetPrice = s.sellTargetPrice;
      state.simPortfolio = s.simPortfolio;
      state.tradeLog = s.tradeLog;
      state.apiConfig = s.apiConfig;

      // Animate price change ticks
      const priceEl = document.getElementById('price-val');
      if (priceEl && oldPrice !== null && state.currentPrice !== oldPrice) {
        priceEl.className = 'price-value';
        if (state.currentPrice > oldPrice) {
          priceEl.classList.add('price-up');
          setTimeout(() => priceEl.classList.remove('price-up'), 250);
        } else {
          priceEl.classList.add('price-down');
          setTimeout(() => priceEl.classList.remove('price-down'), 250);
        }
      }

      // Update Chart Data & Horizontal Lines
      updateChartData();

      // Refresh Dashboard UI components
      updateUI();
      
      // Render Console logs
      renderConsoleLogs(s.systemConsoleLogs);
    } else {
      throw new Error(`Server responded with status ${res.status}`);
    }
  } catch (err) {
    console.error("Dashboard failed to fetch server state:", err);
    const statusIndicator = document.getElementById('ws-status');
    if (statusIndicator) {
      statusIndicator.innerHTML = '<span class="dot disconnected"></span> Server Disconnected';
    }
  }
}

// Post config changes to the server
async function updateServerConfig(payload) {
  if (!sessionState.currentSessionId) return;
  try {
    const res = await fetch(`${getApiUrl()}/api/configure?sessionId=${sessionState.currentSessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("Server rejected configuration update.");
    fetchServerState(); // Trigger immediate update
  } catch (err) {
    console.error(err);
  }
}

// Render dynamic session overlay list
async function initSessionOverlay() {
  const container = document.getElementById('session-list');
  const overlay = document.getElementById('session-overlay');
  if (!container || !overlay) return;

  overlay.style.display = 'flex';
  
  // Fetch session configurations from server
  try {
    const res = await fetch(`${getApiUrl()}/api/sessions`);
    if (res.ok) {
      sessionState.sessions = await res.json();
    }
  } catch (err) {
    console.warn("Could not load sessions from server:", err);
    sessionState.sessions = [
      { id: 1, name: 'Trader 1' },
      { id: 2, name: 'Trader 2' },
      { id: 3, name: 'Trader 3' },
      { id: 4, name: 'Trader 4' },
      { id: 5, name: 'Trader 5' }
    ];
  }

  container.innerHTML = sessionState.sessions.map(sess => `
    <div style="display: flex; gap: 0.5rem; align-items: center; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); padding: 0.75rem; border-radius: 8px;">
      <input type="text" id="session-name-input-${sess.id}" value="${sess.name}" style="flex: 1; height: 36px; padding: 0 0.5rem; background: rgba(0,0,0,0.5); font-size: 0.85rem;" placeholder="Session User Name">
      <button class="btn btn-primary select-session-btn" data-id="${sess.id}" style="width: auto; padding: 0 1rem; height: 36px; font-size: 0.8rem; border-radius: 6px;">Select</button>
    </div>
  `).join('');

  // Attach click listeners to session select buttons
  container.querySelectorAll('.select-session-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = parseInt(e.target.dataset.id);
      const nameInput = document.getElementById(`session-name-input-${id}`);
      const sessionName = nameInput ? nameInput.value.trim() : `Trader ${id}`;
      
      sessionState.currentSessionId = id;
      sessionState.sessions.find(s => s.id === id).name = sessionName;
      
      // Update configuration names on the server
      try {
        await fetch(`${getApiUrl()}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sessionState.sessions)
        });
      } catch (err) {
        console.warn("Could not save session configurations to server:", err);
      }
      
      // Close overlay badge
      overlay.style.display = 'none';
      
      const badgeText = document.getElementById('active-session-name');
      if (badgeText) badgeText.textContent = sessionName;
      
      // Re-trigger server updates
      startStatePolling();
    });
  });
}

// Setup Event Listeners
function setupEventListeners() {
  // Load backend URL input value
  const backendUrlInput = document.getElementById('input-backend-url');
  if (backendUrlInput) {
    backendUrlInput.value = localStorage.getItem('apex_backend_api_url') || '';
  }

  // Start/Pause Bot Button
  const toggleBtn = document.getElementById('btn-toggle-bot');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      const targetState = !state.isRunning;
      try {
        const res = await fetch(`${getApiUrl()}/api/toggle?sessionId=${sessionState.currentSessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isRunning: targetState })
        });
        if (res.ok) {
          fetchServerState();
        }
      } catch (err) {
        console.error("Failed to toggle bot running state:", err);
      }
    });
  }
  
  // Strategy Selector
  const strategySelect = document.getElementById('select-strategy');
  if (strategySelect) {
    strategySelect.addEventListener('change', (e) => {
      updateServerConfig({ strategy: e.target.value });
    });
  }
  
  // Threshold Input
  const thresholdInput = document.getElementById('input-threshold');
  if (thresholdInput) {
    thresholdInput.addEventListener('change', (e) => {
      const val = Math.max(1, parseFloat(e.target.value) || 10);
      updateServerConfig({ threshold: val });
    });
  }
  
  // USD size input
  const sizeInput = document.getElementById('input-trade-amount');
  if (sizeInput) {
    sizeInput.addEventListener('change', (e) => {
      const val = Math.max(1, parseFloat(e.target.value) || 100);
      updateServerConfig({ tradeAmount: val });
    });
  }
  
  // Reference Price Reset Button
  const resetRefBtn = document.getElementById('btn-reset-ref');
  if (resetRefBtn) {
    resetRefBtn.addEventListener('click', () => {
      if (state.currentPrice) {
        updateServerConfig({
          referencePrice: state.currentPrice,
          buyTargetPrice: state.currentPrice // Force sync buy target to spot
        });
      }
    });
  }

  // Editable Target Inputs
  const buyTargetInput = document.getElementById('input-buy-target');
  if (buyTargetInput) {
    buyTargetInput.addEventListener('change', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val > 0) {
        updateServerConfig({ buyTargetPrice: val });
      }
    });
  }

  const sellTargetInput = document.getElementById('input-sell-target');
  if (sellTargetInput) {
    sellTargetInput.addEventListener('change', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val > 0) {
        updateServerConfig({ sellTargetPrice: val });
      }
    });
  }

  // Manual Target Buttons (+/- $10)
  const btnBuyDown = document.getElementById('btn-buy-down');
  const btnBuyUp = document.getElementById('btn-buy-up');
  if (btnBuyDown && btnBuyUp) {
    btnBuyDown.addEventListener('click', () => {
      const val = (state.buyTargetPrice || state.currentPrice) - 10;
      updateServerConfig({ buyTargetPrice: val });
    });
    btnBuyUp.addEventListener('click', () => {
      const val = (state.buyTargetPrice || state.currentPrice) + 10;
      updateServerConfig({ buyTargetPrice: val });
    });
  }

  const btnSellDown = document.getElementById('btn-sell-down');
  const btnSellUp = document.getElementById('btn-sell-up');
  if (btnSellDown && btnSellUp) {
    btnSellDown.addEventListener('click', () => {
      const val = (state.sellTargetPrice || state.currentPrice) - 10;
      updateServerConfig({ sellTargetPrice: val });
    });
    btnSellUp.addEventListener('click', () => {
      const val = (state.sellTargetPrice || state.currentPrice) + 10;
      updateServerConfig({ sellTargetPrice: val });
    });
  }
  
  // Execution Mode selection (Simulated vs Live)
  const modeSelect = document.getElementById('select-mode');
  if (modeSelect) {
    modeSelect.addEventListener('change', async (e) => {
      const targetMode = e.target.value;
      
      // Stop the bot first for safety on mode toggle
      try {
        await fetch(`${getApiUrl()}/api/toggle?sessionId=${sessionState.currentSessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isRunning: false })
        });
        
        await fetch(`${getApiUrl()}/api/api-config?sessionId=${sessionState.currentSessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: state.apiConfig.apiKey,
            apiSecret: state.apiConfig.apiSecret,
            mode: targetMode
          })
        });
        fetchServerState();
      } catch (err) {
        console.error("Failed to update execution mode:", err);
      }
    });
  }
  
  // Save credentials configuration on server
  const btnSaveApi = document.getElementById('btn-save-api');
  if (btnSaveApi) {
    btnSaveApi.addEventListener('click', async () => {
      const keyVal = document.getElementById('input-api-key').value.trim();
      const secVal = document.getElementById('input-api-secret').value.trim();
      
      // Store custom Backend API URL locally
      const backendUrlVal = document.getElementById('input-backend-url').value.trim();
      if (backendUrlVal) {
        localStorage.setItem('apex_backend_api_url', backendUrlVal);
      } else {
        localStorage.removeItem('apex_backend_api_url');
      }

      try {
        const res = await fetch(`${getApiUrl()}/api/api-config?sessionId=${sessionState.currentSessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: keyVal,
            apiSecret: secVal,
            mode: state.mode
          })
        });
        if (res.ok) {
          alert("API and server settings saved successfully.");
          startStatePolling();
        } else {
          alert("Error saving API credentials.");
        }
      } catch (err) {
        console.error(err);
      }
    });
  }
  
  // Clear Logs Button
  const btnClearLogs = document.getElementById('btn-clear-logs');
  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', async () => {
      if (confirm(`Are you sure you want to clear your trade logs for ${state.mode.toUpperCase()} mode?`)) {
        try {
          const res = await fetch(`${getApiUrl()}/api/clear-logs?sessionId=${sessionState.currentSessionId}`, { method: 'POST' });
          if (res.ok) fetchServerState();
        } catch (e) {
          console.error(e);
        }
      }
    });
  }
  
  // Reset Portfolio Button
  const btnResetPortfolio = document.getElementById('btn-reset-portfolio');
  if (btnResetPortfolio) {
    btnResetPortfolio.addEventListener('click', async () => {
      if (confirm("Reset virtual simulated portfolio back to $10,000 USD?")) {
        try {
          const res = await fetch(`${getApiUrl()}/api/reset-portfolio?sessionId=${sessionState.currentSessionId}`, { method: 'POST' });
          if (res.ok) fetchServerState();
        } catch (err) {
          console.error(err);
        }
      }
    });
  }
  
  // API Accordion toggle
  const accordionHeader = document.getElementById('settings-accordion-header');
  const accordionContent = document.getElementById('settings-accordion-content');
  if (accordionHeader && accordionContent) {
    accordionHeader.addEventListener('click', () => {
      accordionHeader.classList.toggle('collapsed');
      accordionContent.classList.toggle('collapsed');
    });
  }
  
  // Export CSV Logs
  const btnExportLogs = document.getElementById('btn-export-logs');
  if (btnExportLogs) {
    btnExportLogs.addEventListener('click', () => {
      exportToCSV();
    });
  }

  // View Online Logs
  const btnViewLogs = document.getElementById('btn-view-logs');
  if (btnViewLogs) {
    btnViewLogs.addEventListener('click', () => {
      window.open(`${getApiUrl()}/api/logs?sessionId=${sessionState.currentSessionId}`, '_blank');
    });
  }

  // Reset Chart Zoom
  const btnResetZoom = document.getElementById('btn-reset-zoom');
  if (btnResetZoom) {
    btnResetZoom.addEventListener('click', () => {
      if (priceChart) {
        priceChart.resetZoom();
      }
    });
  }

  // Switch User
  const btnSwitchSession = document.getElementById('btn-switch-session');
  if (btnSwitchSession) {
    btnSwitchSession.addEventListener('click', () => {
      initSessionOverlay();
    });
  }
}

// Full Dashboard UI Sync
function updateUI() {
  // Update Connection Badge status
  const statusIndicator = document.getElementById('ws-status');
  if (statusIndicator) {
    if (state.currentPrice) {
      statusIndicator.innerHTML = '<span class="dot connected"></span> Live Price Feed';
    } else {
      statusIndicator.innerHTML = '<span class="dot paused"></span> Connecting Feed...';
    }
  }

  // 1. Live Price Display
  const priceValEl = document.getElementById('price-val');
  if (priceValEl && state.currentPrice) {
    priceValEl.textContent = `$${state.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }
  
  // 2. Target Indicators
  const refPriceEl = document.getElementById('ui-ref-price');
  const buyTargetInput = document.getElementById('input-buy-target');
  const sellTargetInput = document.getElementById('input-sell-target');
  
  const holdsBtc = state.simPortfolio.btc > 0.000001;
  
  if (refPriceEl) refPriceEl.textContent = state.referencePrice ? `$${state.referencePrice.toFixed(2)}` : 'Waiting...';
  
  // Sync inputs if user is not editing them
  if (buyTargetInput && document.activeElement !== buyTargetInput) {
    if (state.strategy === 'cycle') {
      buyTargetInput.value = '';
      buyTargetInput.placeholder = holdsBtc ? 'N/A' : 'IMMEDIATE';
    } else {
      buyTargetInput.value = state.buyTargetPrice ? Math.round(state.buyTargetPrice) : '';
      buyTargetInput.placeholder = 'Waiting...';
    }
  }
  
  if (sellTargetInput && document.activeElement !== sellTargetInput) {
    if (state.strategy === 'cycle' && !holdsBtc) {
      sellTargetInput.value = '';
      sellTargetInput.placeholder = 'Waiting Buy...';
    } else {
      sellTargetInput.value = state.sellTargetPrice ? Math.round(state.sellTargetPrice) : '';
      sellTargetInput.placeholder = 'Waiting...';
    }
  }

  // Mode select & form bindings
  const modeSelect = document.getElementById('select-mode');
  if (modeSelect && document.activeElement !== modeSelect) {
    modeSelect.value = state.mode;
  }

  const strategySelect = document.getElementById('select-strategy');
  if (strategySelect && document.activeElement !== strategySelect) {
    strategySelect.value = state.strategy;
  }

  const thresholdInput = document.getElementById('input-threshold');
  if (thresholdInput && document.activeElement !== thresholdInput) {
    thresholdInput.value = state.threshold;
  }

  const sizeInput = document.getElementById('input-trade-amount');
  if (sizeInput && document.activeElement !== sizeInput) {
    sizeInput.value = state.tradeAmount;
  }

  const apiKeyInput = document.getElementById('input-api-key');
  if (apiKeyInput && document.activeElement !== apiKeyInput) {
    apiKeyInput.value = state.apiConfig.apiKey || '';
  }

  const apiSecretInput = document.getElementById('input-api-secret');
  if (apiSecretInput && document.activeElement !== apiSecretInput) {
    apiSecretInput.value = state.apiConfig.apiSecret || '';
  }
  
  // 3. Portfolio Values
  const netWorthEl = document.getElementById('ui-net-worth');
  const usdBalEl = document.getElementById('ui-usd-bal');
  const btcBalEl = document.getElementById('ui-btc-bal');
  const avgCostEl = document.getElementById('ui-avg-cost');
  
  if (state.mode === 'simulated') {
    const currentBtcVal = state.simPortfolio.btc * (state.currentPrice || 0);
    const netWorth = state.simPortfolio.usd + currentBtcVal;
    
    if (netWorthEl) netWorthEl.textContent = `$${netWorth.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    if (usdBalEl) usdBalEl.textContent = `$${state.simPortfolio.usd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    if (btcBalEl) btcBalEl.textContent = `${state.simPortfolio.btc.toFixed(6)} BTC`;
    if (avgCostEl) avgCostEl.textContent = state.simPortfolio.avgBuyPrice > 0 ? `$${state.simPortfolio.avgBuyPrice.toFixed(2)}` : '-';
  } else {
    if (netWorthEl) netWorthEl.textContent = 'Live Trade Mode';
    if (usdBalEl) usdBalEl.textContent = 'Active on Exchange';
    if (btcBalEl) btcBalEl.textContent = 'Active on Exchange';
    if (avgCostEl) avgCostEl.textContent = '-';
  }
  
  // 4. Statistics Block
  const spotPriceEl = document.getElementById('stat-spot-price');
  const totalTradesEl = document.getElementById('stat-total-trades');
  const profitableTradesEl = document.getElementById('stat-profitable-trades');
  const totalProfitEl = document.getElementById('stat-total-profit');
  
  if (spotPriceEl && state.currentPrice) {
    spotPriceEl.textContent = `$${state.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }
  
  const trades = state.tradeLog.filter(t => t.status === state.mode);
  const sellTrades = trades.filter(t => t.type === 'SELL');
  const profitableSells = sellTrades.filter(t => t.pnl > 0);
  const totalPnL = sellTrades.reduce((acc, t) => acc + t.pnl, 0);
  
  if (totalTradesEl) totalTradesEl.textContent = trades.length;
  if (profitableTradesEl) {
    const winRate = sellTrades.length > 0 ? ((profitableSells.length / sellTrades.length) * 100).toFixed(0) : '0';
    profitableTradesEl.textContent = `${profitableSells.length} / ${sellTrades.length} (${winRate}%)`;
  }
  if (totalProfitEl) {
    totalProfitEl.className = 'stat-val';
    if (totalPnL > 0) {
      totalProfitEl.textContent = `+$${totalPnL.toFixed(2)}`;
      totalProfitEl.style.color = 'var(--success)';
    } else if (totalPnL < 0) {
      totalProfitEl.textContent = `-$${Math.abs(totalPnL).toFixed(2)}`;
      totalProfitEl.style.color = 'var(--danger)';
    } else {
      totalProfitEl.textContent = '$0.00';
      totalProfitEl.style.color = 'var(--text-primary)';
    }
  }
  
  // 5. Bot Running Status
  const headerBotStatus = document.getElementById('bot-running-status');
  const controlBtn = document.getElementById('btn-toggle-bot');
  
  if (state.isRunning) {
    if (headerBotStatus) headerBotStatus.innerHTML = '<span class="dot running"></span> Bot Active';
    if (controlBtn) {
      controlBtn.textContent = 'Pause Bot';
      controlBtn.className = 'btn btn-danger';
    }
  } else {
    if (headerBotStatus) headerBotStatus.innerHTML = '<span class="dot paused"></span> Bot Paused';
    if (controlBtn) {
      controlBtn.textContent = 'Start Bot';
      controlBtn.className = 'btn btn-primary';
    }
  }
  
  // 6. Redraw Transaction Logs
  renderTradeLogs();
}

// Render console outputs
function renderConsoleLogs(logs) {
  const statusLog = document.getElementById('status-log-console');
  if (!statusLog) return;
  
  statusLog.innerHTML = '';
  if (!logs || logs.length === 0) {
    statusLog.innerHTML = '<div><span style="color: var(--text-muted); margin-right: 0.5rem;">[BOT]</span> Waiting for price updates or configurations...</div>';
    return;
  }

  logs.forEach(log => {
    const item = document.createElement('div');
    item.style.padding = '0.15rem 0';
    item.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
    
    const timeSpan = document.createElement('span');
    timeSpan.style.color = 'var(--text-muted)';
    timeSpan.style.marginRight = '0.5rem';
    timeSpan.textContent = `[${log.time}]`;
    
    const textSpan = document.createElement('span');
    textSpan.textContent = log.message;
    
    item.appendChild(timeSpan);
    item.appendChild(textSpan);
    statusLog.appendChild(item);
  });
}

// Render historical transactions table
function renderTradeLogs() {
  const container = document.getElementById('logs-table-body');
  if (!container) return;
  
  const currentLogs = state.tradeLog.filter(log => log.status === state.mode);
  
  if (currentLogs.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="9">
          <div class="empty-state">
            <div class="empty-state-icon">📊</div>
            <div>No trades executed in this mode yet.</div>
            <div style="font-size: 0.75rem; margin-top: 0.25rem;">Activate the bot to begin execution.</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }
  
  container.innerHTML = currentLogs.map((log, index) => {
    const logDate = new Date(log.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const pnlDisplay = log.type === 'SELL' 
      ? (log.pnl >= 0 
          ? `<span style="color: var(--success); font-weight: 600;">+$${log.pnl.toFixed(2)}</span>` 
          : `<span style="color: var(--danger); font-weight: 600;">-$${Math.abs(log.pnl).toFixed(2)}</span>`)
      : '-';
      
    // Calculate cumulative PnL on-the-fly up to this transaction
    const olderTrades = currentLogs.slice(index);
    const olderSells = olderTrades.filter(t => t.type === 'SELL');
    const cumulativeProfit = olderSells.reduce((acc, t) => acc + t.pnl, 0);
    
    const cumulativeProfitDisplay = cumulativeProfit >= 0 
      ? `<span style="color: var(--success); font-weight: 600;">$${cumulativeProfit.toFixed(2)}</span>`
      : `<span style="color: var(--danger); font-weight: 600;">-$${Math.abs(cumulativeProfit).toFixed(2)}</span>`;
      
    return `
      <tr>
        <td><code style="background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">${log.id ? log.id.replace('tx_', '') : '-'}</code></td>
        <td>${logDate}</td>
        <td><span class="log-type ${log.type.toLowerCase()}">${log.type}</span></td>
        <td>$${log.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td>${log.amount.toFixed(6)} BTC</td>
        <td>$${log.totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td>${pnlDisplay}</td>
        <td>${cumulativeProfitDisplay}</td>
        <td><span class="log-status ${log.status}">${log.status.toUpperCase()}</span></td>
      </tr>
    `;
  }).join('');
}

// Chart.js Setup
function initChart() {
  const ctx = document.getElementById('price-chart-canvas').getContext('2d');
  
  // Target horizontal lines drawing plugin
  const targetLinesPlugin = {
    id: 'targetLines',
    afterDraw: (chart) => {
      if (state.referencePrice === null) return;
      
      const { ctx, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
      ctx.save();
      
      // 1. Reference Price Line
      const yRef = y.getPixelForValue(state.referencePrice);
      if (yRef >= top && yRef <= bottom) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(left, yRef);
        ctx.lineTo(right, yRef);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '10px Outfit';
        ctx.fillText(`REF BASE: $${state.referencePrice.toFixed(2)}`, right - 95, yRef - 4);
      }
      
      // 2. Buy Target Line
      if (state.buyTargetPrice) {
        const buyTargetWithThreshold = state.strategy === 'swing' ? (state.buyTargetPrice + state.threshold) : (state.buyTargetPrice + state.threshold);
        const targetValue = state.strategy === 'swing' ? (state.buyTargetPrice + state.threshold) : (state.buyTargetPrice + state.threshold);
        const yBuy = y.getPixelForValue(state.strategy === 'cycle' ? state.currentPrice : targetValue);
        
        if (state.strategy !== 'cycle' && yBuy >= top && yBuy <= bottom) {
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(left, yBuy);
          ctx.lineTo(right, yBuy);
          ctx.stroke();
          ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
          ctx.font = '10px Outfit';
          ctx.fillText(`BUY TARGET: $${targetValue.toFixed(2)}`, left + 10, yBuy - 4);
        }
      }
      
      // 3. Sell Target Line
      if (state.sellTargetPrice) {
        const ySell = y.getPixelForValue(state.sellTargetPrice);
        if (ySell >= top && ySell <= bottom) {
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(left, ySell);
          ctx.lineTo(right, ySell);
          ctx.stroke();
          ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
          ctx.font = '10px Outfit';
          ctx.fillText(`SELL TARGET: $${state.sellTargetPrice.toFixed(2)}`, left + 10, ySell - 4);
        }
      }
      
      ctx.restore();
    }
  };
  
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(59, 130, 246, 0.3)');
  gradient.addColorStop(1, 'rgba(59, 130, 246, 0)');
  
  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'BTC-USD',
        data: [],
        borderColor: '#3b82f6',
        borderWidth: 2.5,
        backgroundColor: gradient,
        fill: true,
        tension: 0.2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 10,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(11, 15, 25, 0.95)',
          titleFont: { family: 'Outfit', size: 12 },
          bodyFont: { family: 'Outfit', size: 13, weight: 'bold' },
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return `Price: $${context.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            }
          }
        },
        zoom: {
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'xy',
          },
          pan: {
            enabled: true,
            mode: 'xy',
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#6b7280',
            font: { family: 'Outfit', size: 10 },
            maxTicksLimit: 6
          }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: {
            color: '#6b7280',
            font: { family: 'Outfit', size: 10 },
            callback: (val) => `$${val.toLocaleString()}`
          }
        }
      }
    },
    plugins: [targetLinesPlugin]
  });
}

// Update chart with live ticks
function updateChartData() {
  if (!priceChart) return;
  
  const labels = state.priceHistory.map(h => h.time);
  const prices = state.priceHistory.map(h => h.price);
  
  priceChart.data.labels = labels;
  priceChart.data.datasets[0].data = prices;
  
  priceChart.update('none'); // Silent update
}

// Export CSV local handler
function exportToCSV() {
  const currentLogs = state.tradeLog.filter(log => log.status === state.mode);
  if (currentLogs.length === 0) {
    alert("No trades to export.");
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "ID,Time,Type,Price(USD),Amount(BTC),Total(USD),PnL(USD),CumulativeProfit(USD),Mode\n";
  
  currentLogs.forEach((log, index) => {
    const olderTrades = currentLogs.slice(index);
    const olderSells = olderTrades.filter(t => t.type === 'SELL');
    const cumulativeProfit = olderSells.reduce((acc, t) => acc + t.pnl, 0);

    const row = [
      log.id,
      log.time,
      log.type,
      log.price,
      log.amount,
      log.totalUsd,
      log.type === 'SELL' ? log.pnl : '',
      cumulativeProfit.toFixed(2),
      log.status
    ].join(",");
    csvContent += row + "\n";
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `apex_trades_${state.mode}_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
