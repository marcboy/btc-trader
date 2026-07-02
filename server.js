/* server.js */
// Pure Node.js CORS-enabled HTTP proxy for Coinbase Advanced Trade.
// Zero dependencies required! Run with: node server.js

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Port should bind to process.env.PORT for Render hosting compatibility
const PORT = process.env.PORT || 3000;

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

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Handle API order request
  if (req.method === 'POST' && req.url === '/api/order') {
    let bodyData = '';
    
    req.on('data', chunk => {
      bodyData += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const params = JSON.parse(bodyData);
        const { side, price, amount, apiKey, apiSecret } = params;
        
        if (!apiKey || !apiSecret) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing API Key or API Secret' }));
          return;
        }

        const uppercaseSide = side.toUpperCase(); // BUY or SELL
        const clientOrderId = generateUUID();
        
        // Define Coinbase order configuration
        let orderConfig = {};
        if (uppercaseSide === 'BUY') {
          orderConfig = {
            market_market_ioc: {
              quote_size: parseFloat(amount).toFixed(2)
            }
          };
        } else {
          const baseSize = (parseFloat(amount) / parseFloat(price)).toFixed(6);
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
            'User-Agent': 'ApexBtcTrader/1.0.0',
            'CB-ACCESS-KEY': apiKey,
            'CB-ACCESS-SIGN': signature,
            'CB-ACCESS-TIMESTAMP': timestamp
          }
        };

        console.log(`[Proxy] Dispatching signed ${uppercaseSide} order to Coinbase API. Client Order ID: ${clientOrderId}`);

        const cbReq = https.request(options, (cbRes) => {
          let responseData = '';
          
          cbRes.on('data', chunk => {
            responseData += chunk.toString();
          });
          
          cbRes.on('end', () => {
            const statusCode = cbRes.statusCode;
            console.log(`[Proxy] Coinbase API responded with status ${statusCode}`);
            
            try {
              const cbJson = JSON.parse(responseData);
              
              if (statusCode >= 200 && statusCode < 300) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  success: true,
                  orderId: cbJson.order_id,
                  price: price,
                  size: uppercaseSide === 'BUY' ? (amount / price) : (amount / price),
                  funds: amount,
                  pnl: 0,
                  raw: cbJson
                }));
              } else {
                console.error(`[Proxy Error] Coinbase rejected request:`, cbJson);
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                  success: false, 
                  error: cbJson.message || cbJson.error_details || `Coinbase API returned status ${statusCode}` 
                }));
              }
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Failed to parse response from Coinbase' }));
            }
          });
        });

        cbReq.on('error', (err) => {
          console.error('[Proxy Error] Request failed:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Proxy connection to Coinbase failed' }));
        });

        cbReq.write(coinbaseRequestBody);
        cbReq.end();

      } catch (e) {
        console.error('[Proxy Error] JSON Parse failed:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid request payload' }));
      }
    });
  } 
  // Handle retrieving debug logs
  else if (req.method === 'GET' && req.url === '/api/logs') {
    const logsPath = path.join(__dirname, 'debug_logs.json');
    fs.readFile(logsPath, 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (err) {
        res.end(JSON.stringify([]));
      } else {
        res.end(data);
      }
    });
  }
  // Handle writing debug logs
  else if (req.method === 'POST' && req.url === '/api/logs') {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk.toString(); });
    req.on('end', () => {
      const logsPath = path.join(__dirname, 'debug_logs.json');
      fs.writeFile(logsPath, bodyData, 'utf8', (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
      });
    });
  } 
  // Handle serving static frontend files
  else if (req.method === 'GET') {
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    const extname = path.extname(filePath);
    
    let contentType = 'text/html';
    switch (extname) {
      case '.js':
        contentType = 'text/javascript';
        break;
      case '.css':
        contentType = 'text/css';
        break;
      case '.json':
        contentType = 'application/json';
        break;
      case '.png':
        contentType = 'image/png';
        break;
      case '.jpg':
        contentType = 'image/jpg';
        break;
      case '.svg':
        contentType = 'image/svg+xml';
        break;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          // If file not found, fallback to index.html for SPA routing, or 404
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `File not found: ${req.url}` }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Server error: ${err.code}` }));
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`   APEX BTC TRADING BOT PROXY SERVER RUNNING          `);
  console.log(`   Listening on port: ${PORT}                          `);
  console.log(`=======================================================`);
});

