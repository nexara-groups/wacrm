/**
 * The dev harness page. Deliberately dependency-free — this exists to prove
 * the backend runs, not to preview the product UI. The real interface is the
 * shadcn/ui port in apps/web (NEW_REPO_PLAN.md), which is a separate track.
 */
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nexara WACRM — dev harness</title>
<style>
  :root {
    --bg: #0b0d10; --panel: #14181d; --line: #232a32;
    --text: #e6eaef; --muted: #8b95a3;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149; --accent: #58a6ff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 32px 16px 64px;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  section {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 18px 20px; margin-bottom: 16px;
  }
  h2 { font-size: 14px; margin: 0 0 4px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted); }
  .why { font-size: 13px; color: var(--muted); margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px;
       text-transform: uppercase; letter-spacing: 0.03em; padding: 0 10px 8px 0; }
  td { padding: 7px 10px 7px 0; border-top: 1px solid var(--line); vertical-align: top; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
          border: 1px solid transparent; font-family: var(--mono); }
  .send { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 35%, transparent); }
  .skip { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 35%, transparent); }
  .hold { color: var(--warn); border-color: color-mix(in oklab, var(--warn) 35%, transparent); }
  .summary { font-family: var(--mono); font-size: 14px; padding: 12px 14px;
             background: #0e1216; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 14px; }
  .big { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  .row { display: flex; gap: 28px; flex-wrap: wrap; margin-bottom: 14px; }
  .stat small { display: block; color: var(--muted); font-size: 12px;
                text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
  input, select {
    background: #0e1216; color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 7px 10px; font-family: var(--mono); font-size: 13px;
  }
  label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 5px; }
  .field { display: inline-block; margin: 0 14px 12px 0; }
  pre { font-family: var(--mono); font-size: 12.5px; background: #0e1216;
        border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px;
        overflow-x: auto; margin: 0; }
  .note { font-size: 12.5px; color: var(--muted); margin-top: 12px; }
  code { font-family: var(--mono); font-size: 0.92em; color: var(--accent); }
  @media (max-width: 600px) { body { padding: 20px 12px 48px; } .row { gap: 18px; } }
</style>
</head>
<body>
<main>
  <h1>Nexara WACRM — dev harness</h1>
  <p class="sub">
    Real schema, real modules, real SQL. The D1 migration stream applied to SQLite,
    read through the actual repositories. Nothing on this page is mocked.
  </p>

  <section>
    <h2>Audience preview</h2>
    <p class="why">
      The guarantee: the number shown here is the number that would actually send.
      Skipped contacts are grouped by reason, never listed flat.
    </p>
    <div class="summary" id="summary">loading…</div>
    <div class="row">
      <div class="stat"><span class="big" id="willSend">–</span><small>will send</small></div>
      <div class="stat"><span class="big" id="skipped">–</span><small>skipped</small></div>
      <div class="stat"><span class="big" id="total">–</span><small>considered</small></div>
    </div>
    <table><tbody id="groups"></tbody></table>
  </section>

  <section>
    <h2>Contacts — the two independent gates</h2>
    <p class="why">
      Consent and deliverability are separate axes. Either blocks a send, for different
      reasons, with different reversal rules: an operator may clear a technical
      suppression but never an opt-out.
    </p>
    <table>
      <thead><tr><th>Contact</th><th>Consent</th><th>Deliverability</th><th>Outcome</th></tr></thead>
      <tbody id="contacts"></tbody>
    </table>
  </section>

  <section>
    <h2>Meta error classifier</h2>
    <p class="why">
      Try <code>131026</code> (not on WhatsApp → suppress), <code>131049</code>
      (marketing cap → retry, must never suppress), <code>131047</code> (24h window),
      or an unknown code like <code>999999</code>.
    </p>
    <div class="field">
      <label for="code">Meta error code</label>
      <input id="code" value="131026" size="10">
    </div>
    <div class="field">
      <label for="parameter">Parameter name (for 131009)</label>
      <input id="parameter" placeholder="e.g. to" size="14">
    </div>
    <pre id="classify">loading…</pre>
  </section>

  <section>
    <h2>Seat limit resolution</h2>
    <p class="why">
      Three configured levels, most specific wins. Leave both blank to see the
      platform default of 3.
    </p>
    <div class="field">
      <label for="plan">Plan included seats</label>
      <input id="plan" placeholder="(inherit)" size="10">
    </div>
    <div class="field">
      <label for="override">Account override</label>
      <input id="override" placeholder="(inherit)" size="10">
    </div>
    <pre id="seats">loading…</pre>
  </section>

  <section>
    <h2>Phone normalisation</h2>
    <p class="why">
      The dedup guarantee behind consent-preserving CSV import: every spelling of one
      number must normalise identically, or a re-import re-subscribes someone who opted out.
      Try <code>09876543210</code>, <code>+91 98765 43210</code>, <code>091-98765-43210</code>.
    </p>
    <div class="field">
      <label for="raw">Raw input</label>
      <input id="raw" value="091-98765-43210" size="24">
    </div>
    <pre id="phone">loading…</pre>
  </section>

  <p class="note">
    Dev only — in-memory database, reseeded each boot, no auth. Production runs on
    Cloudflare Workers; the operational store is still gated on the DB benchmark.
  </p>
</main>

<script>
const get = (u) => fetch(u).then((r) => r.json());
const el = (id) => document.getElementById(id);

async function loadAudience() {
  const a = await get('/api/audience');
  el('summary').textContent = a.summary;
  el('willSend').textContent = a.willSend;
  el('skipped').textContent = a.skippedCount;
  el('total').textContent = a.totalConsidered;
  el('groups').innerHTML = a.skipped.map((g) =>
    '<tr><td style="width:60px"><span class="pill skip">' + g.count + '</span></td><td>' + g.reason + '</td></tr>'
  ).join('') || '<tr><td>nothing skipped</td></tr>';
}

async function loadContacts() {
  const rows = await get('/api/contacts');
  el('contacts').innerHTML = rows.map((c) => {
    const blocked = c.consentState === 'opted_out' || c.consentState === 'do_not_contact'
      || c.deliverabilityState === 'suppressed';
    const cls = blocked ? 'skip' : 'send';
    const label = blocked ? 'blocked' : 'will send';
    const code = c.suppressedReasonCode ? ' (' + c.suppressedReasonCode + ')' : '';
    return '<tr><td>' + c.name + '<br><span style="color:var(--muted);font-family:var(--mono);font-size:12px">'
      + c.phone + '</span></td><td><span class="pill ' + (c.consentState === 'opted_out' || c.consentState === 'do_not_contact' ? 'skip' : 'hold') + '">'
      + c.consentState + '</span></td><td><span class="pill ' + (c.deliverabilityState === 'suppressed' ? 'skip' : 'hold') + '">'
      + c.deliverabilityState + code + '</span></td><td><span class="pill ' + cls + '">' + label + '</span></td></tr>';
  }).join('');
}

async function loadClassify() {
  const code = el('code').value.trim() || '131026';
  const p = el('parameter').value.trim();
  const r = await get('/api/classify?code=' + encodeURIComponent(code) + (p ? '&parameter=' + encodeURIComponent(p) : ''));
  el('classify').textContent = JSON.stringify(r, null, 2);
}

async function loadSeats() {
  const plan = el('plan').value.trim();
  const override = el('override').value.trim();
  const q = [];
  if (plan) q.push('plan=' + encodeURIComponent(plan));
  if (override) q.push('override=' + encodeURIComponent(override));
  el('seats').textContent = JSON.stringify(await get('/api/seats' + (q.length ? '?' + q.join('&') : '')), null, 2);
}

async function loadPhone() {
  const raw = el('raw').value;
  el('phone').textContent = JSON.stringify(await get('/api/phone?raw=' + encodeURIComponent(raw)), null, 2);
}

el('code').addEventListener('input', loadClassify);
el('parameter').addEventListener('input', loadClassify);
el('plan').addEventListener('input', loadSeats);
el('override').addEventListener('input', loadSeats);
el('raw').addEventListener('input', loadPhone);

loadAudience(); loadContacts(); loadClassify(); loadSeats(); loadPhone();
</script>
</body>
</html>`;
