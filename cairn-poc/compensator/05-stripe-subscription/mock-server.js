// Mock Stripe subscription lifecycle.
// POST /v1/subscriptions {customer, items:[{price}]} -> {id, status:'incomplete', latest_invoice:{id, status:'open'}}
// Within ~100 ms the invoice transitions to 'paid' and subscription to 'active' — side effects:
//   - invoice.paid webhook delivered (we simulate by logging to events.log)
//   - customer balance updated (stored)
// DELETE /v1/subscriptions/:id -> cancels (status=canceled). Does NOT refund.
// POST /v1/refunds {charge} -> refunds associated charge.
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const EVENTS_LOG = path.join(__dirname, 'events.log');
try { fs.unlinkSync(EVENTS_LOG); } catch {}

const subs = {}; // id -> sub
const invoices = {}; // id -> inv
const charges = {}; // id -> charge
const refunds = {};
const customers = { cus_A: { id: 'cus_A', balance: 0 } };

function logEvent(ev) {
  fs.appendFileSync(EVENTS_LOG, JSON.stringify(ev) + '\n');
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function newId(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 10)}`; }

function finalizeSub(subId) {
  const s = subs[subId];
  if (!s) return;
  // create invoice
  const invId = newId('in');
  const chId = newId('ch');
  const amount = 2000; // cents
  charges[chId] = { id: chId, amount, paid: true, refunded: false, customer: s.customer, invoice: invId };
  invoices[invId] = { id: invId, status: 'paid', customer: s.customer, subscription: subId, charge: chId, amount_paid: amount };
  s.latest_invoice = invId;
  s.status = 'active';
  customers[s.customer].balance += amount; // simulate a side-effect
  logEvent({ type: 'invoice.paid', id: invId, charge: chId, amount });
  logEvent({ type: 'customer.subscription.created', id: subId });
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if (req.method === 'POST' && u.pathname === '/v1/subscriptions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { customer, items } = JSON.parse(body);
      const id = newId('sub');
      subs[id] = { id, customer, items, status: 'incomplete', latest_invoice: null, created: Math.floor(Date.now() / 1000) };
      setTimeout(() => finalizeSub(id), 80);
      json(res, 200, subs[id]);
    });
    return;
  }
  const delSub = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
  if (delSub && req.method === 'DELETE') {
    const s = subs[delSub[1]];
    if (!s) return json(res, 404, { error: { message: 'no sub' } });
    s.status = 'canceled';
    s.canceled_at = Math.floor(Date.now() / 1000);
    logEvent({ type: 'customer.subscription.deleted', id: s.id });
    return json(res, 200, s);
  }
  if (delSub && req.method === 'GET') {
    const s = subs[delSub[1]];
    if (!s) return json(res, 404, { error: { message: 'no sub' } });
    return json(res, 200, s);
  }
  const getInv = u.pathname.match(/^\/v1\/invoices\/([^/]+)$/);
  if (getInv && req.method === 'GET') {
    const i = invoices[getInv[1]];
    if (!i) return json(res, 404, {});
    return json(res, 200, i);
  }
  if (req.method === 'POST' && u.pathname === '/v1/refunds') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { charge } = JSON.parse(body);
      const c = charges[charge];
      if (!c) return json(res, 404, { error: { message: 'no charge' } });
      if (c.refunded) return json(res, 400, { error: { message: 'already refunded' } });
      c.refunded = true;
      const id = newId('re');
      refunds[id] = { id, charge, amount: c.amount };
      customers[c.customer].balance -= c.amount;
      logEvent({ type: 'charge.refunded', id, charge });
      return json(res, 200, refunds[id]);
    });
    return;
  }
  const getCust = u.pathname.match(/^\/v1\/customers\/([^/]+)$/);
  if (getCust && req.method === 'GET') {
    const c = customers[getCust[1]];
    if (!c) return json(res, 404, {});
    return json(res, 200, c);
  }
  json(res, 404, { error: { message: 'not found' } });
});
const PORT = process.env.PORT || 4105;
server.listen(PORT, () => console.log(`[mock-stripe] listening on ${PORT}`));
