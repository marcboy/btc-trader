/* app.js */

// Global State
let state = {
  isRunning: false,
  mode: 'simulated', // 'simulated' | 'live'
  strategy: 'swing', // 'swing' (buy low/sell high) | 'trend' (buy high/sell low)
  threshold: 10, // Price diff to trigger order
  tradeAmount: 100, // USD per trade
  
  // Simulated Portfolio
  simPortfolio: {
    usd: 10000,
    btc: 0,
    avgBuyPrice: 0,
    totalInvested: 0,
    activePositionId: null
  },
  
  // Prices & Targets
  currentPrice: null,
  priceChange24h: 0,
  referencePrice: null,
  buyTargetPrice: null,
  sellTargetPrice: null,
  
  // Lists
  priceHistory: [], // Max 50 points
  tradeLog: [],
  
  // API credentials (saved in browser local storage)
  apiConfig: {
    apiKey: '',
    apiSecret: '',
    proxyUrl: 'http://localhost:3000'
  }
};

// Chart Instance
let priceChart = null;

// WebSocket Instance
let ws = null;
let wsReconnectTimer = null;

// URL-based Reset Trigger (detects index.html?reset=true)
if (window.location.search.includes('reset=true')) {
  localStorage.removeItem('apex_sim_portfolio');
  localStorage.removeItem('apex_trade_log');
  localStorage.removeItem('apex_api_config');
  localStorage.removeItem('apex_bot_config');
  window.location.replace(window.location.pathname);
}

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  initChart();
  connectWebSocket();
  setupEventListeners();
  updateUI();
});

// Load state from localStorage
function loadFromStorage() {
  const savedSim = localStorage.getItem('apex_sim_portfolio');
  if (savedSim) {
    state.simPortfolio = JSON.parse(savedSim);
  }
  
  const savedLogs = localStorage.getItem('apex_trade_log');
  if (savedLogs) {
    state.tradeLog = JSON.parse(savedLogs);
  }

  const savedApi = localStorage.getItem('apex_api_config');
  if (savedApi) {
    state.apiConfig = JSON.parse(savedApi);
  }
  
  const savedBot = localStorage.getItem('apex_bot_config');
  if (savedBot) {
    const config = JSON.parse(savedBot);
    state.strategy = config.strategy || 'swing';
    state.threshold = Number(config.threshold) || 10;
    state.tradeAmount = Number(config.tradeAmount) || 100;
  }
}

// Save state to localStorage
function saveState() {
  localStorage.setItem('apex_sim_portfolio', JSON.stringify(state.simPortfolio));
  localStorage.setItem('apex_trade_log', JSON.stringify(state.tradeLog));
  localStorage.setItem('apex_api_config', JSON.stringify(state.apiConfig));
  localStorage.setItem('apex_bot_config', JSON.stringify({
    strategy: state.strategy,
    threshold: state.threshold,
    tradeAmount: state.tradeAmount
  }));
}

// Connect to Coinbase Pro / Advanced WebSocket
function connectWebSocket() {
  if (ws) {
    ws.close();
  }
  
  const statusIndicator = document.getElementById('ws-status');
  statusIndicator.innerHTML = '<span class="dot paused"></span> Connecting...';
  
  // Coinbase public WebSocket feed
  ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  
  ws.onopen = () => {
    console.log('WebSocket Connected');
    statusIndicator.innerHTML = '<span class="dot connected"></span> Live Price Feed';
    
    // Subscribe to BTC-USD ticker
    const subMessage = {
      type: 'subscribe',
      product_ids: ['BTC-USD'],
      channels: ['ticker']
    };
    ws.send(JSON.stringify(subMessage));
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'ticker' && data.price) {
      const price = parseFloat(data.price);
      handleNewPrice(price);
    }
  };
  
  ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
    statusIndicator.innerHTML = '<span class="dot disconnected"></span> Connection Error';
  };
  
  ws.onclose = () => {
    console.log('WebSocket Closed. Retrying in 5s...');
    statusIndicator.innerHTML = '<span class="dot disconnected"></span> Disconnected';
    
    // Auto reconnect
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, 5000);
  };
}

// Handle incoming price feed ticks
function handleNewPrice(price) {
  const oldPrice = state.currentPrice;
  state.currentPrice = price;
  
  // Calculate 24h change mock if WebSocket doesn't supply it (Coinbase ticker usually does)
  // Or we can mock it based on price movement to look interactive
  
  // Tick animation on price element
  const priceEl = document.getElementById('price-val');
  if (priceEl && oldPrice !== null) {
    priceEl.className = 'price-value';
    if (price > oldPrice) {
      priceEl.classList.add('price-up');
      setTimeout(() => priceEl.classList.remove('price-up'), 200);
    } else if (price < oldPrice) {
      priceEl.classList.add('price-down');
      setTimeout(() => priceEl.classList.remove('price-down'), 200);
    }
  }
  
  // Add to price history (cap at 50 ticks)
  const now = new Date();
  state.priceHistory.push({ time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), price: price });
  if (state.priceHistory.length > 50) {
    state.priceHistory.shift();
  }
  
  // Update Chart
  updateChartData();
  
  // Initialize reference price if not set
  if (state.referencePrice === null) {
    state.referencePrice = price;
    recalculateTargets();
  }
  
  // Run bot tick
  if (state.isRunning) {
    runTradingBot();
  }
  
  // General UI updates (portfolio worth, stats, labels)
  updateUI();
}

// Recalculate Buy/Sell Target lines based on current reference price and strategy
function recalculateTargets() {
  if (state.referencePrice === null) return;
  
  if (state.strategy === 'swing') {
    // Swing: Buy when price goes DOWN by threshold, Sell when price goes UP by threshold
    state.buyTargetPrice = state.referencePrice - state.threshold;
    state.sellTargetPrice = state.referencePrice + state.threshold;
  } else if (state.strategy === 'trend') {
    // Trend: Buy when price goes UP by threshold, Sell when price goes DOWN by threshold
    state.buyTargetPrice = state.referencePrice + state.threshold;
    state.sellTargetPrice = state.referencePrice - state.threshold;
  } else if (state.strategy === 'cycle') {
    // Sequential Scalper: Buy is immediate, Sell is baseline + threshold
    state.buyTargetPrice = null;
    state.sellTargetPrice = state.referencePrice + state.threshold;
  }
}

// Run bot strategy matching
function runTradingBot() {
  if (state.currentPrice === null || state.referencePrice === null) return;
  
  const current = state.currentPrice;
  const ref = state.referencePrice;
  const diff = current - ref;
  
  // Check holdings to see if we possess BTC
  const liveTrades = state.tradeLog.filter(t => t.status === 'live');
  const holdsBtc = state.mode === 'simulated'
    ? state.simPortfolio.btc > 0.000001
    : (liveTrades.length > 0 && liveTrades[0].type === 'BUY');
  
  if (state.strategy === 'swing') {
    // Swing Grid Strategy: Buy low, Sell high
    
    // BUY Trigger: Price drops below buyTargetPrice (down by $10 or more)
    if (current <= state.buyTargetPrice) {
      executeTrade('BUY', current);
      state.referencePrice = current;
      recalculateTargets();
    } 
    // SELL Trigger: Price rises above sellTargetPrice (up by $10 or more)
    else if (current >= state.sellTargetPrice) {
      executeTrade('SELL', current);
      state.referencePrice = current;
      recalculateTargets();
    }
  } else if (state.strategy === 'trend') {
    // Trend Following Strategy: Buy high (breakout), Sell low (breakdown)
    
    // BUY Trigger: Price breaks above buyTargetPrice (up by $10 or more)
    if (current >= state.buyTargetPrice) {
      executeTrade('BUY', current);
      state.referencePrice = current;
      recalculateTargets();
    } 
    // SELL Trigger: Price drops below sellTargetPrice (down by $10 or more)
    else if (current <= state.sellTargetPrice) {
      executeTrade('SELL', current);
      state.referencePrice = current;
      recalculateTargets();
    }
  } else if (state.strategy === 'cycle') {
    // Sequential Scalper Strategy: Buy immediate, Sell at +threshold, repeat
    
    if (!holdsBtc) {
      // Buy immediately!
      executeTrade('BUY', current);
      state.referencePrice = current;
      recalculateTargets();
    } else {
      // Wait for price to rise by threshold to sell
      if (current >= state.sellTargetPrice) {
        executeTrade('SELL', current);
        state.referencePrice = current;
        recalculateTargets();
      }
    }
  }
}

// Execute BUY or SELL order (Simulated or Live API)
async function executeTrade(side, price) {
  if (state.mode === 'simulated') {
    executeSimulatedTrade(side, price);
  } else {
    await executeLiveTrade(side, price);
  }
  saveState();
}

// Executing trade in virtual simulator
function executeSimulatedTrade(side, price) {
  const feeRate = 0.004; // 0.4% Coinbase Advanced fee tier
  
  if (side === 'BUY') {
    const usdToSpend = state.tradeAmount;
    if (state.simPortfolio.usd < usdToSpend) {
      logSystemMessage(`Incomplete BUY: Insufficient USD balance ($${state.simPortfolio.usd.toFixed(2)} vs required $${usdToSpend.toFixed(2)})`);
      return;
    }
    
    const fee = usdToSpend * feeRate;
    const netUsd = usdToSpend - fee;
    const btcBought = netUsd / price;
    
    // Update portfolio
    const positionId = generateId();
    state.simPortfolio.usd -= usdToSpend;
    state.simPortfolio.btc += btcBought;
    state.simPortfolio.totalInvested += usdToSpend;
    state.simPortfolio.avgBuyPrice = state.simPortfolio.totalInvested / state.simPortfolio.btc;
    state.simPortfolio.activePositionId = positionId;
    
    // Record log
    const trade = {
      id: positionId,
      time: new Date().toISOString(),
      type: 'BUY',
      price: price,
      amount: btcBought,
      totalUsd: usdToSpend,
      fee: fee,
      pnl: 0,
      status: 'simulated'
    };
    
    state.tradeLog.unshift(trade);
    logSystemMessage(`Simulated BUY Executed: Bought ${btcBought.toFixed(6)} BTC at $${price.toFixed(2)} [ID: ${positionId}]`);
  } 
  else if (side === 'SELL') {
    // Sell the entire accumulated BTC holding to realize profit
    const btcToSell = state.simPortfolio.btc;
    
    if (btcToSell <= 0.000001) {
      logSystemMessage(`Incomplete SELL: No BTC holding to sell.`);
      return;
    }
    
    const grossUsd = btcToSell * price;
    const fee = grossUsd * feeRate;
    const netUsdReceived = grossUsd - fee;
    
    // Calculate PnL: USD received minus original USD spent to buy this BTC
    const costBasis = state.simPortfolio.totalInvested;
    const pnl = netUsdReceived - costBasis;
    
    // Retrieve linked position ID or generate fallback
    const positionId = state.simPortfolio.activePositionId || generateId();
    
    // Update portfolio
    state.simPortfolio.usd += netUsdReceived;
    
    // Reset metrics since we sold everything
    state.simPortfolio.btc = 0;
    state.simPortfolio.avgBuyPrice = 0;
    state.simPortfolio.totalInvested = 0;
    state.simPortfolio.activePositionId = null;
    
    // Record log
    const trade = {
      id: positionId,
      time: new Date().toISOString(),
      type: 'SELL',
      price: price,
      amount: btcToSell,
      totalUsd: netUsdReceived,
      fee: fee,
      pnl: pnl,
      status: 'simulated'
    };
    
    state.tradeLog.unshift(trade);
    logSystemMessage(`Simulated SELL Executed: Sold ${btcToSell.toFixed(6)} BTC at $${price.toFixed(2)} (PnL: $${pnl.toFixed(2)}) [ID: ${positionId}]`);
  }
}

// Execute Live trade via Node.js API Proxy
async function executeLiveTrade(side, price) {
  if (!state.apiConfig.apiKey || !state.apiConfig.apiSecret) {
    logSystemMessage("Live Trade Failed: API Keys not configured. Toggle to 'Simulation' or supply credentials.");
    toggleBot(false);
    return;
  }
  
  logSystemMessage(`Sending Live ${side} Order to proxy server...`);
  
  try {
    const response = await fetch(`${state.apiConfig.proxyUrl}/api/order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        side: side.toLowerCase(),
        price: price,
        amount: state.tradeAmount,
        apiKey: state.apiConfig.apiKey,
        apiSecret: state.apiConfig.apiSecret
      })
    });
    
    const result = await response.json();
    
    if (response.ok && result.success) {
      const trade = {
        id: result.orderId || generateId(),
        time: new Date().toISOString(),
        type: side,
        price: parseFloat(result.price || price),
        amount: parseFloat(result.size),
        totalUsd: parseFloat(result.funds || (price * result.size)),
        fee: parseFloat(result.fee || 0),
        pnl: parseFloat(result.pnl || 0),
        status: 'live'
      };
      
      state.tradeLog.unshift(trade);
      logSystemMessage(`LIVE ${side} Order Executed! Filled ${trade.amount.toFixed(6)} BTC at $${trade.price.toFixed(2)}`);
    } else {
      throw new Error(result.error || 'Unknown proxy error');
    }
  } catch (error) {
    console.error('API Error:', error);
    logSystemMessage(`LIVE ORDER ERROR: ${error.message}. Please check if the local Node.js proxy server is running.`);
    toggleBot(false); // Pause bot on error for safety
  }
}

// Add system event message to trade log as a notice
function logSystemMessage(message) {
  console.log(`[BOT] ${message}`);
  const statusLog = document.getElementById('status-log-console');
  if (statusLog) {
    const item = document.createElement('div');
    item.style.padding = '0.35rem 0';
    item.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
    item.style.fontSize = '0.8rem';
    
    const timeSpan = document.createElement('span');
    timeSpan.style.color = 'var(--text-muted)';
    timeSpan.style.marginRight = '0.5rem';
    timeSpan.textContent = new Date().toLocaleTimeString();
    
    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    
    item.appendChild(timeSpan);
    item.appendChild(textSpan);
    
    statusLog.insertBefore(item, statusLog.firstChild);
  }
}

// Helper to generate trade ID
function generateId() {
  return 'tx_' + Math.random().toString(36).substr(2, 9);
}

// Chart.js initialization
function initChart() {
  const ctx = document.getElementById('price-chart-canvas').getContext('2d');
  
  // Custom horizontal line plugin
  const targetLinesPlugin = {
    id: 'targetLines',
    afterDraw: (chart) => {
      if (state.referencePrice === null) return;
      
      const { ctx, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
      ctx.save();
      
      // Draw Reference Price Line
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
      
      // Draw Buy Target Line
      if (state.buyTargetPrice) {
        const yBuy = y.getPixelForValue(state.buyTargetPrice);
        if (yBuy >= top && yBuy <= bottom) {
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(left, yBuy);
          ctx.lineTo(right, yBuy);
          ctx.stroke();
          ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
          ctx.font = '10px Outfit';
          ctx.fillText(`BUY TARGET: $${state.buyTargetPrice.toFixed(2)}`, left + 10, yBuy - 4);
        }
      }
      
      // Draw Sell Target Line
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
  
  // Create beautiful line gradient
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

// Update chart with latest data points
function updateChartData() {
  if (!priceChart) return;
  
  const labels = state.priceHistory.map(h => h.time);
  const prices = state.priceHistory.map(h => h.price);
  
  priceChart.data.labels = labels;
  priceChart.data.datasets[0].data = prices;
  
  priceChart.update('none'); // Update without animation for speed
}

// Full UI re-render
function updateUI() {
  // 1. Live Price Banner
  const priceValEl = document.getElementById('price-val');
  if (priceValEl && state.currentPrice) {
    priceValEl.textContent = `$${state.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }
  
  // 2. Targets UI
  const refPriceEl = document.getElementById('ui-ref-price');
  const buyTargetEl = document.getElementById('ui-buy-target');
  const sellTargetEl = document.getElementById('ui-sell-target');
  
  const liveTrades = state.tradeLog.filter(t => t.status === 'live');
  const holdsBtc = state.mode === 'simulated'
    ? state.simPortfolio.btc > 0.000001
    : (liveTrades.length > 0 && liveTrades[0].type === 'BUY');
  
  if (refPriceEl) refPriceEl.textContent = state.referencePrice ? `$${state.referencePrice.toFixed(2)}` : 'Waiting...';
  
  if (buyTargetEl) {
    if (state.strategy === 'cycle') {
      buyTargetEl.textContent = holdsBtc ? 'N/A' : 'IMMEDIATE';
      buyTargetEl.style.color = holdsBtc ? 'var(--text-muted)' : 'var(--success)';
    } else {
      buyTargetEl.textContent = state.buyTargetPrice ? `$${state.buyTargetPrice.toFixed(2)}` : 'Waiting...';
      buyTargetEl.style.color = '';
    }
  }
  
  if (sellTargetEl) {
    if (state.strategy === 'cycle' && !holdsBtc) {
      sellTargetEl.textContent = 'Waiting for Buy...';
      sellTargetEl.style.color = 'var(--text-muted)';
    } else {
      sellTargetEl.textContent = state.sellTargetPrice ? `$${state.sellTargetPrice.toFixed(2)}` : 'Waiting...';
      sellTargetEl.style.color = '';
    }
  }
  
  // 3. Portfolio Card
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
    // For live exchange mode, query live balances via local proxy or display a status
    if (netWorthEl) netWorthEl.textContent = 'Live Trading';
    if (usdBalEl) usdBalEl.textContent = 'Querying API...';
    if (btcBalEl) btcBalEl.textContent = 'Querying API...';
    if (avgCostEl) avgCostEl.textContent = '-';
  }
  
  // 4. Statistics Block
  const totalTradesEl = document.getElementById('stat-total-trades');
  const profitableTradesEl = document.getElementById('stat-profitable-trades');
  const totalProfitEl = document.getElementById('stat-total-profit');
  
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
  
  // 6. Redraw Trading Logs
  renderTradeLogs();
}

// Render historical transactions table
function renderTradeLogs() {
  const container = document.getElementById('logs-table-body');
  if (!container) return;
  
  const currentLogs = state.tradeLog.filter(log => log.status === state.mode);
  
  if (currentLogs.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state">
            <div class="empty-state-icon">📊</div>
            <div>No trades executed in this mode yet.</div>
            <div style="font-size: 0.75rem; margin-top: 0.25rem;">Start the bot to execute orders.</div>
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

// Setup Event Handlers
function setupEventListeners() {
  // Start/Pause Bot
  const toggleBtn = document.getElementById('btn-toggle-bot');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      toggleBot(!state.isRunning);
    });
  }
  
  // Strategy selection
  const strategySelect = document.getElementById('select-strategy');
  if (strategySelect) {
    strategySelect.addEventListener('change', (e) => {
      state.strategy = e.target.value;
      recalculateTargets();
      saveState();
      updateUI();
      logSystemMessage(`Strategy updated to: ${state.strategy.toUpperCase()}`);
    });
    // Set initial UI value
    strategySelect.value = state.strategy;
  }
  
  // Trading threshold
  const thresholdInput = document.getElementById('input-threshold');
  if (thresholdInput) {
    thresholdInput.addEventListener('change', (e) => {
      const val = Math.max(1, parseFloat(e.target.value) || 10);
      state.threshold = val;
      e.target.value = val;
      recalculateTargets();
      saveState();
      updateUI();
      logSystemMessage(`Threshold trigger set to: $${val}`);
    });
    thresholdInput.value = state.threshold;
  }
  
  // Trading USD size
  const sizeInput = document.getElementById('input-trade-amount');
  if (sizeInput) {
    sizeInput.addEventListener('change', (e) => {
      const val = Math.max(1, parseFloat(e.target.value) || 100);
      state.tradeAmount = val;
      e.target.value = val;
      saveState();
      updateUI();
      logSystemMessage(`Trade size per trigger set to: $${val}`);
    });
    sizeInput.value = state.tradeAmount;
  }
  
  // Reference Price Reset Button
  const resetRefBtn = document.getElementById('btn-reset-ref');
  if (resetRefBtn) {
    resetRefBtn.addEventListener('click', () => {
      if (state.currentPrice) {
        state.referencePrice = state.currentPrice;
        recalculateTargets();
        updateUI();
        logSystemMessage(`Reference baseline price reset manually to: $${state.currentPrice.toFixed(2)}`);
      }
    });
  }
  
  // Mode selection (Simulated vs Live)
  const modeSelect = document.getElementById('select-mode');
  if (modeSelect) {
    modeSelect.addEventListener('change', (e) => {
      const isSim = e.target.value === 'simulated';
      state.mode = isSim ? 'simulated' : 'live';
      
      // Safety: pause bot when switching modes
      toggleBot(false);
      
      updateUI();
      logSystemMessage(`Operating mode changed to: ${state.mode.toUpperCase()}`);
      
      // Update UI panels visibility
      const apiCard = document.getElementById('settings-panel-card');
      if (apiCard) {
        if (state.mode === 'live') {
          apiCard.style.display = 'block';
          // Open accordion automatically
          document.getElementById('settings-accordion-content').classList.remove('collapsed');
          document.getElementById('settings-accordion-header').classList.remove('collapsed');
        } else {
          // In simulation, we can keep it block but let user check it
          apiCard.style.display = 'block';
        }
      }
    });
    modeSelect.value = state.mode;
  }
  
  // API Form Fields Save
  const btnSaveApi = document.getElementById('btn-save-api');
  if (btnSaveApi) {
    btnSaveApi.addEventListener('click', () => {
      state.apiConfig.apiKey = document.getElementById('input-api-key').value.trim();
      state.apiConfig.apiSecret = document.getElementById('input-api-secret').value.trim();
      state.apiConfig.proxyUrl = document.getElementById('input-proxy-url').value.trim() || 'http://localhost:3000';
      
      saveState();
      logSystemMessage("API Credentials saved securely locally. Connecting through proxy...");
      alert("Settings saved locally! Make sure your Node.js proxy server is running at " + state.apiConfig.proxyUrl + " if you enable Live Mode.");
    });
    
    // Load config values into inputs
    document.getElementById('input-api-key').value = state.apiConfig.apiKey;
    document.getElementById('input-api-secret').value = state.apiConfig.apiSecret;
    document.getElementById('input-proxy-url').value = state.apiConfig.proxyUrl;
  }
  
  // Clear Logs Button
  const btnClearLogs = document.getElementById('btn-clear-logs');
  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', () => {
      if (confirm(`Are you sure you want to clear your trade logs for ${state.mode.toUpperCase()} mode?`)) {
        state.tradeLog = state.tradeLog.filter(log => log.status !== state.mode);
        saveState();
        updateUI();
        logSystemMessage(`Cleared ${state.mode.toUpperCase()} trade logs.`);
      }
    });
  }
  
  // Reset Portfolio Button
  const btnResetPortfolio = document.getElementById('btn-reset-portfolio');
  if (btnResetPortfolio) {
    btnResetPortfolio.addEventListener('click', () => {
      if (confirm("Reset virtual simulated portfolio back to $10,000 USD?")) {
        state.simPortfolio = {
          usd: 10000,
          btc: 0,
          avgBuyPrice: 0,
          totalInvested: 0
        };
        saveState();
        updateUI();
        logSystemMessage("Virtual portfolio reset to $10,000 USD.");
      }
    });
  }
  
  // API Settings Accordion Toggle
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
}

// Start / Pause Bot helper
function toggleBot(run) {
  state.isRunning = run;
  saveState();
  updateUI();
  
  if (run) {
    if (state.currentPrice) {
      state.referencePrice = state.currentPrice;
      recalculateTargets();
    }
    logSystemMessage(`AUTO-TRADER ACTIVE: Threshold is $${state.threshold}. Reference base is $${state.referencePrice ? state.referencePrice.toFixed(2) : 'Waiting for price...'}`);
  } else {
    logSystemMessage("AUTO-TRADER PAUSED: All automated execution halted.");
  }
}

// Export trade history to CSV
function exportToCSV() {
  const currentLogs = state.tradeLog.filter(log => log.status === state.mode);
  if (currentLogs.length === 0) {
    alert("No trades to export.");
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "ID,Time,Type,Price(USD),Amount(BTC),Total(USD),PnL(USD),CumulativeProfit(USD),Mode\n";
  
  currentLogs.forEach((log, index) => {
    // Calculate cumulative PnL on-the-fly up to this transaction
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
