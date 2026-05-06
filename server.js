// Instantly email_opened webhook receiver + snapshot endpoint for Max (LEA)
// Pure Node.js - no npm dependencies required
const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN_GH;
const GITHUB_REPO = 'almadigitalsystems/almadigitaldesigns';
const DATA_PATH = 'data/opens';
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const SNAPSHOT_AUTH_TOKEN = process.env.SNAPSHOT_AUTH_TOKEN;

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

function fetchInstantly(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.instantly.ai',
      path: '/api/v2' + path,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + INSTANTLY_API_KEY,
        'User-Agent': 'AlmaDigital-Snapshot/1.0',
        'Accept': 'application/json'
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json: ' + data.slice(0, 200))); }
        } else {
          reject(new Error('instantly ' + res.statusCode + ': ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function slimCampaign(c) {
  return {
    campaign_id: c.campaign_id,
    campaign_name: c.campaign_name,
    campaign_status: c.campaign_status,
    leads_count: c.leads_count || 0,
    sends: c.emails_sent_count || 0,
    contacted: c.contacted_count || 0,
    opens: c.open_count || 0,
    opens_unique: c.open_count_unique || 0,
    replies: c.reply_count || 0,
    replies_unique: c.reply_count_unique || 0,
    bounces: c.bounced_count || 0,
    unsubscribed: c.unsubscribed_count || 0,
    link_clicks: c.link_click_count || 0
  };
}

async function handleSnapshot(req, res, parsed) {
  if (!INSTANTLY_API_KEY) {
    res.writeHead(503, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({error: 'INSTANTLY_API_KEY not configured'}));
  }
  if (SNAPSHOT_AUTH_TOKEN) {
    const auth = req.headers['authorization'] || '';
    const expected = 'Bearer ' + SNAPSHOT_AUTH_TOKEN;
    if (auth !== expected) {
      res.writeHead(401, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({error: 'unauthorized'}));
    }
  }
  const campaignId = parsed.query.campaign_id;
  const path = '/campaigns/analytics' + (campaignId ? ('?campaign_id=' + encodeURIComponent(campaignId)) : '');
  try {
    const data = await fetchInstantly(path);
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    const slim = arr.map(slimCampaign);
    const total = slim.reduce((acc, c) => {
      acc.leads_count += c.leads_count;
      acc.sends += c.sends;
      acc.contacted += c.contacted;
      acc.opens += c.opens;
      acc.replies += c.replies;
      acc.bounces += c.bounces;
      return acc;
    }, {leads_count: 0, sends: 0, contacted: 0, opens: 0, replies: 0, bounces: 0});
    res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    return res.end(JSON.stringify({
      generated_at: new Date().toISOString(),
      campaign_id_filter: campaignId || null,
      campaigns: slim,
      totals: total
    }, null, 2));
  } catch (e) {
    res.writeHead(502, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({error: 'instantly_fetch_failed', detail: e.message}));
  }
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'GET' && parsed.pathname === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({status: 'ok', service: 'instantly-open-tracker', ts: new Date().toISOString()}));
  }

  if (req.method === 'GET' && parsed.pathname === '/snapshot') {
    return handleSnapshot(req, res, parsed);
  }

  if (req.method === 'POST' && parsed.pathname === '/webhook') {
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
