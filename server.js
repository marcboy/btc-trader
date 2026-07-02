/* server.js */
// Pure Node.js CORS-enabled HTTP proxy for Coinbase Advanced Trade.
// Zero dependencies required! Run with: node server.js

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = 3000;

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
          // Quote size represents USD to spend
          orderConfig = {
            market_market_ioc: {
              quote_size: parseFloat(amount).toFixed(2)
            }
          };
        } else {
          // Base size represents BTC to sell. Convert USD target amount to BTC equivalent
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
                // Success
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  success: true,
                  orderId: cbJson.order_id,
                  price: price,
                  size: uppercaseSide === 'BUY' ? (amount / price) : (amount / price), // Estimated size or fetched
                  funds: amount,
                  pnl: 0,
                  raw: cbJson
                }));
              } else {
                // Coinbase API error
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
  } else {
    // 404 for other endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`   APEX BTC TRADING BOT PROXY SERVER RUNNING          `);
  console.log(`   Listening on: http://localhost:${PORT}               `);
  console.log(`   No Node dependencies required. Keep running.       `);
  console.log(`=======================================================`);
});
