// Generates n8n/workflows/*.json (importable via n8n "Import from file").  Run: node scripts/build-n8n-workflows.mjs
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('n8n/workflows');
fs.mkdirSync(out, { recursive: true });

const APP_URL = 'http://localhost:4300'; // edit after import if n8n runs elsewhere
const conn = (from, to, idx = 0) => ({ [from]: { main: [...Array(idx).fill([]), [{ node: to, type: 'main', index: 0 }]] } });
const merge = (...cs) => cs.reduce((a, c) => {
  for (const [k, v] of Object.entries(c)) {
    if (!a[k]) a[k] = { main: [] };
    v.main.forEach((arr, i) => { a[k].main[i] = [...(a[k].main[i] ?? []), ...arr]; });
  }
  return a;
}, {});

const resendNode = (name, position, subjectExpr, textExpr) => ({
  parameters: {
    method: 'POST',
    url: 'https://api.resend.com/emails',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({ from: 'Amir SM <REPLACE_WITH_VERIFIED_SENDER@yourdomain.com>', to: ['REPLACE_WITH_YOUR_ADDRESS@example.com'], subject: ${subjectExpr}, text: ${textExpr} }) }}`,
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position, name,
  credentials: { httpHeaderAuth: { id: 'REPLACE', name: 'Resend API key (Authorization: Bearer re_...)' } },
});

const appGet = (name, position, pathPart) => ({
  parameters: {
    method: 'GET', url: `${APP_URL}${pathPart}`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {},
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position, name,
  credentials: { httpHeaderAuth: { id: 'REPLACE', name: 'Amir SM inbound token (Authorization: Bearer <N8N_INBOUND_TOKEN>)' } },
});

const write = (file, wf) => fs.writeFileSync(path.join(out, file), JSON.stringify({ ...wf, active: false, settings: { executionOrder: 'v1' }, pinData: {} }, null, 2) + '\n');

// 1) Event notifier ------------------------------------------------------------------------------
write('amir-sm-event-notifier.json', {
  name: 'Amir SM — render notifier',
  nodes: [
    {
      parameters: { httpMethod: 'POST', path: 'amir-sm-events', authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
      type: 'n8n-nodes-base.webhook', typeVersion: 2.2, position: [0, 0], name: 'Amir SM event', webhookId: 'amir-sm-events-0001',
      credentials: { httpHeaderAuth: { id: 'REPLACE', name: 'Amir SM webhook secret (header x-amirsm-secret = N8N_WEBHOOK_SECRET)' } },
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'or',
          conditions: [
            { id: 'c1', leftValue: '={{ $json.body.event }}', rightValue: 'version.ready', operator: { type: 'string', operation: 'equals' } },
            { id: 'c2', leftValue: '={{ $json.body.event }}', rightValue: 'version.failed', operator: { type: 'string', operation: 'equals' } },
          ],
        },
        options: {},
      },
      type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [240, 0], name: 'Ready or failed?',
    },
    resendNode(
      'Email me (Resend)', [480, -80],
      "$json.body.event === 'version.ready' ? `Amir SM: draft v${$json.body.data.number} of “${$json.body.data.title}” is ready to review` : `Amir SM: draft v${$json.body.data.number} of “${$json.body.data.title}” failed`",
      "$json.body.event === 'version.ready' ? 'Open Amir SM > Social Studio to watch the draft, review the caption, and approve or request changes.' : `The render failed: ${$json.body.data.error || 'see Amir SM for details'}. You can retry from the project page.`",
    ),
  ],
  connections: merge(conn('Amir SM event', 'Ready or failed?'), conn('Ready or failed?', 'Email me (Resend)', 0)),
  meta: { description: 'Receives signed-by-secret events from the Amir SM app and emails you when a draft is ready or failed. Replace the sender/recipient placeholders and select credentials after import. Inactive by default.' },
});

// 2) Daily digest ----------------------------------------------------------------------------------
write('amir-sm-daily-digest.json', {
  name: 'Amir SM — daily digest',
  nodes: [
    { parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] } }, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.4, position: [0, 0], name: 'Every morning 08:00' },
    appGet('Get digest from Amir SM', [240, 0], '/api/integrations/n8n/digest'),
    {
      parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: 'd1', leftValue: '={{ $json.hasItems }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] }, options: {} },
      type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [480, 0], name: 'Anything to report?',
    },
    resendNode(
      'Email digest (Resend)', [720, -80], "'Amir SM — your morning digest'",
      "['Awaiting your review:', ...($json.awaitingReview.length ? $json.awaitingReview : ['nothing']), '', 'Failed in the last 24h:', ...($json.failedLast24h.length ? $json.failedLast24h : ['nothing']), '', `Email drafts pending: ${$json.emailDraftsPending}`, `Threads needing a reply: ${$json.threadsNeedingReply}`].join('\\n')",
    ),
  ],
  connections: merge(conn('Every morning 08:00', 'Get digest from Amir SM'), conn('Get digest from Amir SM', 'Anything to report?'), conn('Anything to report?', 'Email digest (Resend)', 0)),
  meta: { description: 'Daily summary pulled from the Amir SM app (reviews waiting, failures, email drafts). Sends nothing when there is nothing to report. Inactive by default.' },
});

// 3) Research feeds ingest ---------------------------------------------------------------------------
write('amir-sm-research-feeds.json', {
  name: 'Amir SM — research from public RSS feeds',
  nodes: [
    { parameters: { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 9, triggerAtMinute: 0 }] } }, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.4, position: [0, 0], name: 'Weekly (Mon 09:00)' },
    {
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "// EDIT THIS LIST: public RSS/Atom feeds you are allowed to read (blogs, newsletters, creator-economy news).\nconst feeds = [\n  { url: 'https://example.com/replace-with-a-public-feed.xml', label: 'Example feed' },\n];\nreturn feeds.map((f) => ({ json: f }));" },
      type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 0], name: 'Feeds to read',
    },
    { parameters: { url: '={{ $json.url }}', options: {} }, type: 'n8n-nodes-base.rssFeedRead', typeVersion: 1.2, position: [480, 0], name: 'Read feed' },
    {
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "const items = $input.all().slice(0, 50).map((i) => ({\n  kind: 'inspiration',\n  title: String(i.json.title || 'Untitled').slice(0, 160),\n  body: String(i.json.contentSnippet || i.json.content || '').slice(0, 1500),\n  sourceUrl: i.json.link && /^https?:\\/\\//.test(i.json.link) ? i.json.link : null,\n  sourceLabel: 'RSS',\n  tags: ['rss'],\n}));\nreturn [{ json: { source: 'rss-weekly', notes: items } }];" },
      type: 'n8n-nodes-base.code', typeVersion: 2, position: [720, 0], name: 'Shape as research notes',
    },
    {
      parameters: { method: 'POST', url: `${APP_URL}/api/integrations/n8n/research/ingest`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}', options: {} },
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [960, 0], name: 'Save to Amir SM Research',
      credentials: { httpHeaderAuth: { id: 'REPLACE', name: 'Amir SM inbound token (Authorization: Bearer <N8N_INBOUND_TOKEN>)' } },
    },
  ],
  connections: merge(conn('Weekly (Mon 09:00)', 'Feeds to read'), conn('Feeds to read', 'Read feed'), conn('Read feed', 'Shape as research notes'), conn('Shape as research notes', 'Save to Amir SM Research')),
  meta: { description: 'Pulls posts from public RSS feeds YOU list and saves them as research notes in Amir SM. No scraping of social platforms. Inactive by default.' },
});
console.log('wrote workflows to', out);
