/* server.js */
// 24/7 Server-side Apex BTC Trading Bot & CORS-enabled proxy.
// Zero-dependency (except 'ws') web application back-end.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Bind to process.env.PORT for cloud hosting compatibility
const PORT = process.env.PORT || 3000;

// Path to persist application state on the server
const STATE_FILE_PATH = path.join(__dirname, 'bot_state.json');

// Global Application State (persisted on disk)
let globalState = {
  currentPrice: null,
  priceHistory: [], // Array of { time, price } up to 100 points
  sessions: {
    1: createDefaultSession(1, 'Trader 1'),
    2: createDefaultSession(2, 'Trader 2'),
    3: createDefaultSession(3, 'Trader 3'),
    4: createDefaultSession(4, 'Trader 4'),
    5: createDefaultSession(5, 'Trader 5')
  }
};

// Console logs wrapper that also writes to session-specific log structures
function logBotMessage(sessionId, message) {
  const timeStr = new Date().toLocaleTimeString();
  const fullMsg = `[Session ${sessionId}] ${message}`;
  console.log(`[BOT] [${timeStr}] ${fullMsg}`);
  
  if (globalState.sessions[sessionId]) {
    globalState.sessions[sessionId].systemConsoleLogs.unshift({
      time: timeStr,
      message: message
    });
    // Cap system console logs at 100 entries
    if (globalState.sessions[sessionId].systemConsoleLogs.length > 100) {
      globalState.sessions[sessionId].systemConsoleLogs.pop();
    }
  }
}

function createDefaultSession(id, name) {
  return {
    id: id,
    name: name,
    isRunning: false,
    mode: 'simulated', // 'simulated' | 'live'
    strategy: 'swing', // 'swing' | 'trend' | 'cycle'
    threshold: 10,
    tradeAmount: 100,
    referencePrice: null,
    buyTargetPrice: null,
    sellTargetPrice: null,
    simPortfolio: {
      usd: 10000,
      btc: 0,
      avgBuyPrice: 0,
      totalInvested: 0,
      activePositionId: null
    },
    apiConfig: {
      apiKey: '',
      apiSecret: '',
      proxyUrl: '' // not strictly needed, backend is self-contained now
    },
    tradeLog: [], // Array of trades
    systemConsoleLogs: [] // Console messages for UI feed
  };
}

// Load persisted state from disk
function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const rawData = fs.readFileSync(STATE_FILE_PATH, 'utf8');
      const parsed = JSON.parse(rawData);
      
      // Merge with default structure to prevent runtime properties errors
      globalState.priceHistory = parsed.priceHistory || [];
      globalState.currentPrice = parsed.currentPrice || null;
      
      if (parsed.sessions) {
        for (const id in parsed.sessions) {
          globalState.sessions[id] = {
            ...createDefaultSession(id, parsed.sessions[id].name || `Trader ${id}`),
            ...parsed.sessions[id]
          };
        }
      }
      console.log(`[Server] State loaded successfully from disk. (${Object.keys(globalState.sessions).length} sessions loaded)`);
    } else {
      console.log(`[Server] No state file found. Starting with default state.`);
      saveStateToDisk();
    }
  } catch (err) {
    console.error(`[Server Error] Failed to load state:`, err);
  }
}

// Save state to disk
function saveStateToDisk() {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(globalState, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Server Error] Failed to save state to disk:`, err);
  }
}

// Helper to generate UUID-like client order IDs
function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Function to sign Coinbase requests (V3 Advanced Trade HMAC authentication)
function signCoinbaseRequest(secret, timestamp, method, path, body) {
  const message = timestamp + method + path + body;
  return crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');
}

// Connect to Coinbase WebSocket feed
let wsConnection = null;
let wsReconnectTimer = null;

function connectCoinbaseWebSocket() {
  if (wsConnection) {
    try { wsConnection.terminate(); } catch (e) {}
  }

  console.log('[Server] Connecting to Coinbase WebSocket feed...');
  wsConnection = new WebSocket('wss://ws-feed.exchange.coinbase.com');

  wsConnection.on('open', () => {
    console.log('[Server] Coinbase WebSocket Connected.');
    for (const id in globalState.sessions) {
      logBotMessage(id, "WebSocket Connected: Live Coinbase BTC-USD tick stream active.");
    }
    const subscribeMsg = {
      type: 'subscribe',
      product_ids: ['BTC-USD'],
      channels: ['ticker']
    };
    wsConnection.send(JSON.stringify(subscribeMsg));
  });

  wsConnection.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'ticker' && message.price) {
        const price = parseFloat(message.price);
        handleNewPrice(price);
      }
    } catch (err) {
      console.error('[Server WS Error] Failed to parse message:', err);
    }
  });

  wsConnection.on('error', (err) => {
    console.error('[Server WS Error] WebSocket encountered error:', err.message);
  });

  wsConnection.on('close', () => {
    console.log('[Server WS Close] WebSocket connection closed. Reconnecting in 5s...');
    for (const id in globalState.sessions) {
      logBotMessage(id, "WebSocket Disconnected: Attempting reconnect to Coinbase feed in 5s...");
    }
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectCoinbaseWebSocket, 5000);
  });
}

// Recalculate Buy/Sell targets for a specific session
function recalculateTargets(session) {
  if (session.referencePrice === null) return;
  
  if (session.strategy === 'swing') {
    session.sellTargetPrice = session.referencePrice + session.threshold;
    if (session.buyTargetPrice === null) {
      session.buyTargetPrice = session.referencePrice - session.threshold;
    }
  } else if (session.strategy === 'trend') {
    session.sellTargetPrice = session.referencePrice - session.threshold;
    if (session.buyTargetPrice === null) {
      session.buyTargetPrice = session.referencePrice + session.threshold;
    }
  } else if (session.strategy === 'cycle') {
    session.buyTargetPrice = null;
    session.sellTargetPrice = session.referencePrice + session.threshold;
  }
}

// Handle incoming price ticks
function handleNewPrice(price) {
  globalState.currentPrice = price;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  globalState.priceHistory.push({ time: timeStr, price: price });
  if (globalState.priceHistory.length > 100) {
    globalState.priceHistory.shift();
  }

  // Evaluate bot logic for each active session
  let stateModified = false;
  for (const id in globalState.sessions) {
    const session = globalState.sessions[id];
    
    // Initialize reference price if missing
    if (session.referencePrice === null) {
      session.referencePrice = price;
      recalculateTargets(session);
      stateModified = true;
    }

    if (session.isRunning) {
      const nowMs = Date.now();
      if (!session.lastTickLogTime || nowMs - session.lastTickLogTime > 15000) {
        session.lastTickLogTime = nowMs;
        const diff = price - session.referencePrice;
        logBotMessage(session.id, `Live Check - Spot: $${price.toFixed(2)} (Ref: $${session.referencePrice.toFixed(2)}, Diff: $${diff.toFixed(2)}, Target Threshold: $${session.threshold})`);
        stateModified = true; // Save log update to disk
      }

      const triggered = runTradingBot(session, price);
      if (triggered) {
        stateModified = true;
      }
    }
  }

  if (stateModified) {
    saveStateToDisk();
  }
}

// Evaluate Strategy logic
function runTradingBot(session, currentPrice) {
  const liveTrades = session.tradeLog.filter(t => t.status === 'live');
  const holdsBtc = session.mode === 'simulated'
    ? session.simPortfolio.btc > 0.000001
    : (liveTrades.length > 0 && liveTrades[0].type === 'BUY');
  
  let didTrade = false;

  if (session.strategy === 'swing') {
    // BUY Trigger: Reaches manual buy target + threshold offset
    if (!holdsBtc && session.buyTargetPrice && currentPrice <= (session.buyTargetPrice + session.threshold)) {
      executeTrade(session, 'BUY', currentPrice);
      session.referencePrice = currentPrice;
      recalculateTargets(session);
      didTrade = true;
    } 
    // SELL Trigger: Price rises above sellTargetPrice (driven by threshold)
    else if (holdsBtc && session.sellTargetPrice && currentPrice >= session.sellTargetPrice) {
      executeTrade(session, 'SELL', currentPrice);
      session.referencePrice = currentPrice;
      recalculateTargets(session);
      didTrade = true;
    }
  } else if (session.strategy === 'trend') {
    // BUY Trigger: Price breaks above manual buy target + threshold offset
    if (!holdsBtc && session.buyTargetPrice && currentPrice >= (session.buyTargetPrice + session.threshold)) {
      executeTrade(session, 'BUY', currentPrice);
      session.referencePrice = currentPrice;
      recalculateTargets(session);
      didTrade = true;
    } 
    // SELL Trigger: Price drops below sellTargetPrice (driven by threshold)
    else if (holdsBtc && session.sellTargetPrice && currentPrice <= session.sellTargetPrice) {
      executeTrade(session, 'SELL', currentPrice);
      session.referencePrice = currentPrice;
      recalculateTargets(session);
      didTrade = true;
    }
  } else if (session.strategy === 'cycle') {
    if (!holdsBtc) {
      executeTrade(session, 'BUY', currentPrice);
      session.referencePrice = currentPrice;
      recalculateTargets(session);
      didTrade = true;
    } else {
      if (currentPrice >= session.sellTargetPrice) {
        executeTrade(session, 'SELL', currentPrice);
        session.referencePrice = currentPrice;
        recalculateTargets(session);
        didTrade = true;
      }
    }
  }

  return didTrade;
}

// Execute BUY or SELL order (Simulated or Live Coinbase API)
function executeTrade(session, side, price) {
  if (session.mode === 'simulated') {
    executeSimulatedTrade(session, side, price);
  } else {
    executeLiveTrade(session, side, price);
  }
}

function executeSimulatedTrade(session, side, price) {
  const feeRate = 0.004; // 0.4% Coinbase Advanced fee tier
  
  if (side === 'BUY') {
    const usdToSpend = session.tradeAmount;
    if (session.simPortfolio.usd < usdToSpend) {
      logBotMessage(session.id, `Incomplete BUY: Insufficient USD balance ($${session.simPortfolio.usd.toFixed(2)} vs required $${usdToSpend.toFixed(2)})`);
      return;
    }
    
    const fee = usdToSpend * feeRate;
    const netUsd = usdToSpend - fee;
    const btcBought = netUsd / price;
    
    const positionId = 'tx_' + Math.random().toString(36).substr(2, 9);
    session.simPortfolio.usd -= usdToSpend;
    session.simPortfolio.btc += btcBought;
    session.simPortfolio.totalInvested += usdToSpend;
    session.simPortfolio.avgBuyPrice = session.simPortfolio.totalInvested / session.simPortfolio.btc;
    session.simPortfolio.activePositionId = positionId;
    
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
    
    session.tradeLog.unshift(trade);
    logBotMessage(session.id, `Simulated BUY Executed: Bought ${btcBought.toFixed(6)} BTC at $${price.toFixed(2)} [ID: ${positionId}]`);
  } 
  else if (side === 'SELL') {
    const btcToSell = session.simPortfolio.btc;
    if (btcToSell <= 0.000001) {
      logBotMessage(session.id, `Incomplete SELL: No BTC holding to sell.`);
      return;
    }
    
    const grossUsd = btcToSell * price;
    const fee = grossUsd * feeRate;
    const netUsdReceived = grossUsd - fee;
    
    const costBasis = session.simPortfolio.totalInvested;
    const pnl = netUsdReceived - costBasis;
    
    const positionId = session.simPortfolio.activePositionId || ('tx_' + Math.random().toString(36).substr(2, 9));
    
    session.simPortfolio.usd += netUsdReceived;
    session.simPortfolio.btc = 0;
    session.simPortfolio.avgBuyPrice = 0;
    session.simPortfolio.totalInvested = 0;
    session.simPortfolio.activePositionId = null;
    
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
    
    session.tradeLog.unshift(trade);
    logBotMessage(session.id, `Simulated SELL Executed: Sold ${btcToSell.toFixed(6)} BTC at $${price.toFixed(2)} (PnL: $${pnl.toFixed(2)}) [ID: ${positionId}]`);
  }
}

// Live execution utilizing Coinbase V3 Advanced Trade REST API
function executeLiveTrade(session, side, price) {
  const { apiKey, apiSecret } = session.apiConfig;
  if (!apiKey || !apiSecret) {
    logBotMessage(session.id, "Live Trade Failed: API Keys not configured. Toggle to 'Simulation' or configure credentials.");
    session.isRunning = false;
    return;
  }
  
  logBotMessage(session.id, `Dispatching Live ${side} Order to Coinbase Advanced Trade...`);
  
  const uppercaseSide = side.toUpperCase();
  const clientOrderId = generateUUID();
  
  let orderConfig = {};
  if (uppercaseSide === 'BUY') {
    orderConfig = {
      market_market_ioc: {
        quote_size: parseFloat(session.tradeAmount).toFixed(2)
      }
    };
  } else {
    const baseSize = (parseFloat(session.tradeAmount) / parseFloat(price)).toFixed(6);
    orderConfig = {
      market_market_ioc: {
        base_size: baseSize
      }
    };
  }

  const coinbaseRequestBody = JSON.stringify({
    client_order_id: clientOrderId,
    product_id: 'BTC-USD',
    side: uppercaseSide,
    order_configuration: orderConfig
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const apiPath = '/api/v3/brokerage/orders';
  const signature = signCoinbaseRequest(apiSecret, timestamp, 'POST', apiPath, coinbaseRequestBody);

  const options = {
    hostname: 'api.coinbase.com',
    path: apiPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ApexBtcTrader/2.0.0',
      'CB-ACCESS-KEY': apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp
    }
  };

  const cbReq = https.request(options, (cbRes) => {
    let responseData = '';
    cbRes.on('data', chunk => { responseData += chunk.toString(); });
    cbRes.on('end', () => {
      const statusCode = cbRes.statusCode;
      try {
        const cbJson = JSON.parse(responseData);
        if (statusCode >= 200 && statusCode < 300) {
          const trade = {
            id: cbJson.order_id || clientOrderId,
            time: new Date().toISOString(),
            type: uppercaseSide,
            price: price,
            amount: uppercaseSide === 'BUY' ? (session.tradeAmount / price) : (session.tradeAmount / price),
            totalUsd: session.tradeAmount,
            fee: 0, // Filled fees queried later or estimated
            pnl: 0,
            status: 'live'
          };
          session.tradeLog.unshift(trade);
          logBotMessage(session.id, `LIVE ${uppercaseSide} Order Executed! Filled order via Coinbase API.`);
          saveStateToDisk();
        } else {
          logBotMessage(session.id, `LIVE ORDER REJECTED: ${cbJson.message || cbJson.error_details || 'API error'}`);
          session.isRunning = false;
        }
      } catch (err) {
        logBotMessage(session.id, `LIVE ORDER ERROR: Failed to parse Coinbase response.`);
      }
    });
  });

  cbReq.on('error', (err) => {
    logBotMessage(session.id, `LIVE ORDER CONNECTION ERROR: ${err.message}`);
    session.isRunning = false;
  });

  cbReq.write(coinbaseRequestBody);
  cbReq.end();
}

// HTTP Server handling REST requests and static frontend serving
const server = http.createServer((req, res) => {
  // Setup CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse Query Parameters
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const querySessionId = parseInt(parsedUrl.searchParams.get('sessionId')) || 1;

  // Endpoint: Get centralized state for dashboard UI
  if (req.method === 'GET' && parsedUrl.pathname === '/api/dashboard-state') {
    const session = globalState.sessions[querySessionId] || createDefaultSession(querySessionId, `Trader ${querySessionId}`);
    
    const responsePayload = {
      currentPrice: globalState.currentPrice,
      priceHistory: globalState.priceHistory,
      session: {
        id: session.id,
        name: session.name,
        isRunning: session.isRunning,
        mode: session.mode,
        strategy: session.strategy,
        threshold: session.threshold,
        tradeAmount: session.tradeAmount,
        referencePrice: session.referencePrice,
        buyTargetPrice: session.buyTargetPrice,
        sellTargetPrice: session.sellTargetPrice,
        simPortfolio: session.simPortfolio,
        tradeLog: session.tradeLog,
        systemConsoleLogs: session.systemConsoleLogs
      }
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responsePayload));
    return;
  }

  // Endpoint: Configure bot settings
  if (req.method === 'POST' && parsedUrl.pathname === '/api/configure') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const session = globalState.sessions[querySessionId];
        if (!session) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Session not found' }));
          return;
        }

        const data = JSON.parse(body);
        if (data.strategy !== undefined) session.strategy = data.strategy;
        if (data.threshold !== undefined) session.threshold = Number(data.threshold);
        if (data.tradeAmount !== undefined) session.tradeAmount = Number(data.tradeAmount);
        
        if (data.buyTargetPrice !== undefined) session.buyTargetPrice = data.buyTargetPrice;
        if (data.sellTargetPrice !== undefined) session.sellTargetPrice = data.sellTargetPrice;
        if (data.referencePrice !== undefined) session.referencePrice = data.referencePrice;

        recalculateTargets(session);
        saveStateToDisk();
        
        logBotMessage(session.id, `Configuration updated: Strategy=${session.strategy.toUpperCase()}, Threshold=$${session.threshold}`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid config payload' }));
      }
    });
    return;
  }

  // Endpoint: Start/Stop Bot
  if (req.method === 'POST' && parsedUrl.pathname === '/api/toggle') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const session = globalState.sessions[querySessionId];
        if (!session) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Session not found' }));
          return;
        }
        
        const data = JSON.parse(body);
        session.isRunning = !!data.isRunning;
        
        if (session.isRunning) {
          if (globalState.currentPrice) {
            session.referencePrice = globalState.currentPrice;
            recalculateTargets(session);
          }
          logBotMessage(session.id, `AUTO-TRADER ACTIVATED: Strategy: ${session.strategy.toUpperCase()}, Threshold: $${session.threshold}`);
        } else {
          logBotMessage(session.id, `AUTO-TRADER PAUSED.`);
        }
        
        saveStateToDisk();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, isRunning: session.isRunning }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // Endpoint: Reset portfolio cash
  if (req.method === 'POST' && parsedUrl.pathname === '/api/reset-portfolio') {
    const session = globalState.sessions[querySessionId];
    if (session) {
      session.simPortfolio = {
        usd: 10000,
        btc: 0,
        avgBuyPrice: 0,
        totalInvested: 0,
        activePositionId: null
      };
      session.tradeLog = session.tradeLog.filter(l => l.status !== 'simulated');
      logBotMessage(session.id, "Virtual portfolio and simulated trade history reset.");
      saveStateToDisk();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Session not found' }));
    }
    return;
  }

  // Endpoint: Clear specific session trade logs
  if (req.method === 'POST' && parsedUrl.pathname === '/api/clear-logs') {
    const session = globalState.sessions[querySessionId];
    if (session) {
      session.tradeLog = [];
      logBotMessage(session.id, "Trade logs cleared.");
      saveStateToDisk();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Session not found' }));
    }
    return;
  }

  // Endpoint: Save API config parameters
  if (req.method === 'POST' && parsedUrl.pathname === '/api/api-config') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const session = globalState.sessions[querySessionId];
        if (!session) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Session not found' }));
          return;
        }
        
        const data = JSON.parse(body);
        session.apiConfig.apiKey = (data.apiKey || '').trim();
        session.apiConfig.apiSecret = (data.apiSecret || '').trim();
        session.mode = data.mode || session.mode;

        logBotMessage(session.id, "Coinbase API configuration updated locally on server.");
        saveStateToDisk();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // Endpoint: Retrieve sessions list
  if (req.method === 'GET' && parsedUrl.pathname === '/api/sessions') {
    const sessionList = Object.values(globalState.sessions).map(s => ({
      id: s.id,
      name: s.name
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessionList));
    return;
  }

  // Endpoint: Update session details (e.g. rename session)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/sessions') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const sessionsData = JSON.parse(body); // Array of { id, name }
        sessionsData.forEach(item => {
          if (globalState.sessions[item.id]) {
            globalState.sessions[item.id].name = item.name;
          }
        });
        saveStateToDisk();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Malformed payload' }));
      }
    });
    return;
  }

  // Legacy/Compatibility Logs Endpoint
  if (req.method === 'GET' && parsedUrl.pathname === '/api/logs') {
    const session = globalState.sessions[querySessionId];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session ? session.tradeLog : []));
    return;
  }

  // Serve static files (HTML, CSS, JS)
  if (req.method === 'GET') {
    let filePath = path.join(__dirname, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);
    const extname = path.extname(filePath);
    
    let contentType = 'text/html';
    switch (extname) {
      case '.js': contentType = 'text/javascript'; break;
      case '.css': contentType = 'text/css'; break;
      case '.json': contentType = 'application/json'; break;
      case '.png': contentType = 'image/png'; break;
      case '.jpg': contentType = 'image/jpg'; break;
      case '.svg': contentType = 'image/svg+xml'; break;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `File not found: ${parsedUrl.pathname}` }));
      } else {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }
});

// Initialize State and WebSocket connection
loadStateFromDisk();
connectCoinbaseWebSocket();

// Start serving
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`   APEX 24/7 AUTO-TRADER SERVER ENGINE ACTIVE         `);
  console.log(`   Web Dashboard served on port: ${PORT}              `);
  console.log(`=======================================================`);
});
