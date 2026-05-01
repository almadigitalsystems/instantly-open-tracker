// Instantly email_opened webhook receiver
// Pure Node.js - no npm dependencies required
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN_GH;
const GITHUB_REPO = 'almadigitalsystems/almadigitaldesigns';
const DATA_PATH = 'data/opens';

async function recordOpenToGitHub(leadEmail, campaignId, campaignName, isFirst, timestamp) {
  if (!GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN_GH not set');
    return false;
  }
  const safeEmail = (leadEmail || 'unknown').replace(/[^a-zA-Z0-9@._-]/g, '_');
  const ts = (timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
  const filename = ts + '_' + safeEmail + '.json';
  const filepath = DATA_PATH + '/' + filename;
  const content = JSON.stringify({
    lead_email: leadEmail,
    campaign_id: campaignId,
    campaign_name: campaignName,
    is_first_open: isFirst,
    timestamp: timestamp || new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    processed: false
  }, null, 2);

  const body = JSON.stringify({
    message: 'Warm lead open: ' + leadEmail,
    content: Buffer.from(content).toString('base64'),
    branch: 'master'
  });

  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: '/repos/' + GITHUB_REPO + '/contents/' + filepath,
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'instantly-open-tracker/1.0',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.content) {
            console.log('[github] Recorded: ' + filepath);
            resolve(true);
          } else {
            console.error('[github] Error:', r.message);
            resolve(false);
          }
        } catch (e) { resolve(false); }
      });
    });
    req.on('error', e => { console.error('[github] Req error:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({status: 'ok', service: 'instantly-open-tracker', ts: new Date().toISOString()}));
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const eventType = data.event_type || data.type;
        const leadEmail = data.lead_email || data.email;
        console.log('[webhook] ' + eventType + ' | ' + leadEmail);
        res.writeHead(200, {'Content-Type': 'application/json'});
        if (eventType !== 'email_opened' || !leadEmail) {
          return res.end(JSON.stringify({received: true, action: 'ignored'}));
        }
        res.end(JSON.stringify({received: true, action: 'processing'}));
        recordOpenToGitHub(leadEmail, data.campaign_id, data.campaign_name, data.is_first !== false, data.timestamp)
          .then(ok => { if (!ok) console.error('[webhook] Failed to record for', leadEmail); });
      } catch (e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: e.message}));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log('[server] Listening on port ' + PORT));
