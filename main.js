// ═══════════════════════════════════════════════════════════════
//  main.js — BizTrack Pro Application Logic
//
//  MIGRATION NOTES (localStorage → SQLite):
//  • DB object is defined and loaded in db.js (window.DB).
//  • All calls to save() are replaced by BizDB.save() — async,
//    fire-and-forget; UI updates from in-memory cache instantly.
//  • STORE_KEY / load() / save() removed (handled by db.js).
//  • exportJSON / importJSON now delegate to BizDB helpers.
//  • Startup is async: DOMContentLoaded awaits BizDB.init().
//  • UTF-8 fix: badge labels use plain ASCII string literals
//    (no template-encoded special chars) — encoding is stable.
// ═══════════════════════════════════════════════════════════════
'use strict';

// ─── ID GENERATOR ─────────────────────────────────────────────
const nextId = (prefix, arr) => prefix + String(arr.length + 1).padStart(4, '0');

// ─── CURRENCY FORMATTING ─────────────────────────────────────
const fmt = (n) => {
  const c = DB.settings.currency || 'UGX';
  const v = Math.round(Number(n) || 0);
  return `${c} ${v.toLocaleString()}`;
};

const fmtShort = (n) => {
  const v = Math.abs(Math.round(Number(n) || 0));
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toLocaleString();
};

const fmtDate = (d) => {
  if (!d) return '\u2014';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

const today = () => new Date().toISOString().slice(0, 10);

const isOverdue = (sale) => {
  if (sale.status === 'PAID') return false;
  if (!sale.dueDate) return false;
  return new Date(sale.dueDate) < new Date();
};

// ─── NAVIGATION ───────────────────────────────────────────────
let currentPage = 'dashboard';

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const pg = document.getElementById('page-' + name);
  if (pg) pg.classList.add('active');
  currentPage = name;
  document.querySelectorAll('.nav-btn').forEach(b => {
    if (b.getAttribute('onclick') && b.getAttribute('onclick').includes("'" + name + "'"))
      b.classList.add('active');
  });
  if (name === 'dashboard') renderDashboard();
  if (name === 'sales')     renderSales();
  if (name === 'inventory') renderInventory();
  if (name === 'expenses')  renderExpenses();
  if (name === 'reports')   rptRange('month');
  if (name === 'settings')  loadSettingsForm();
}

// ─── MODALS ───────────────────────────────────────────────────
let currentSaleId = null;

function openModal(id) {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('open');
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  const m = document.getElementById(id);
  if (m) m.style.display = 'block';
  if (id === 'modal-sale')    { populateDatalists(); updateSalePreview(); }
  if (id === 'modal-restock') populateRestockDropdown();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
}

function overlayClick(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

// ─── ONBOARDING ───────────────────────────────────────────────
async function finishOnboarding() {
  const biz  = document.getElementById('ob-biz').value.trim();
  const own  = document.getElementById('ob-owner').value.trim();
  const type = document.getElementById('ob-type').value;
  const cur  = document.getElementById('ob-currency').value;
  if (!biz) { alert('Please enter your business name'); return; }
  DB.settings.bizName   = biz;
  DB.settings.owner     = own;
  DB.settings.type      = type || 'General Shop';
  DB.settings.currency  = cur;
  BizDB.save();
  document.getElementById('onboard').classList.add('gone');
  document.getElementById('h-bizname').textContent = biz;
  renderAll();
  toast('Welcome to BizTrack Pro! \uD83C\uDF89');
}

// ─── RENDER ALL ───────────────────────────────────────────────
function renderAll() {
  document.getElementById('h-bizname').textContent = DB.settings.bizName || 'BizTrack';
  renderDashboard();
  if (currentPage === 'sales')     renderSales();
  if (currentPage === 'inventory') renderInventory();
  if (currentPage === 'expenses')  renderExpenses();
}

// ─── DASHBOARD ────────────────────────────────────────────────
function renderDashboard() {
  const sales    = DB.sales;
  const revenue  = sales.reduce((s, r) => s + (r.total   || 0), 0);
  const coll     = sales.reduce((s, r) => s + (r.paid    || 0), 0);
  const owed     = sales.reduce((s, r) => s + (r.balance || 0), 0);
  const expenses = DB.expenses.reduce((s, r) => s + (r.amount || 0), 0);
  const netP     = revenue - expenses;

  setKPI('kpi-rev',    fmtShort(revenue),  DB.settings.currency);
  setKPI('kpi-coll',   fmtShort(coll),     DB.settings.currency);
  setKPI('kpi-owed',   fmtShort(owed),     DB.settings.currency);
  setKPI('kpi-exp',    fmtShort(expenses), DB.settings.currency);
  setKPI('kpi-profit', fmtShort(netP),     DB.settings.currency);
  setKPI('kpi-cnt',    String(sales.length), '');

  // Recent sales
  const recent = [...sales].reverse().slice(0, 5);
  const rEl    = document.getElementById('recent-sales-list');
  if (recent.length === 0) {
    rEl.innerHTML = '<div class="empty"><div class="empty-icon">\uD83D\uDCCB</div><div class="empty-text">No sales yet</div><div class="empty-sub">Tap + to record your first sale</div></div>';
  } else {
    rEl.innerHTML = recent.map(s => saleListItem(s)).join('');
  }

  // Alerts
  const now      = new Date();
  const overdue  = sales.filter(s => s.status !== 'PAID' && s.balance > 0 && s.dueDate && new Date(s.dueDate) < now);
  const upcoming = sales.filter(s => s.status !== 'PAID' && s.balance > 0 && s.dueDate && new Date(s.dueDate) >= now);
  const supOwed  = DB.suppliers.filter(s => (s.balance || 0) > 0);
  const lowStock = DB.inventory.filter(p => (p.stock || 0) <= (p.reorder || DB.settings.lowStock || 5));

  let alertsHtml = '';
  if (overdue.length > 0) {
    const total = overdue.reduce((s, r) => s + (r.balance || 0), 0);
    alertsHtml += `<div class="alert alert-error">\uD83D\uDD34 <strong>${overdue.length} overdue</strong> \u2014 ${fmt(total)} owed past due date</div>`;
  }
  if (upcoming.length > 0) {
    const total = upcoming.reduce((s, r) => s + (r.balance || 0), 0);
    alertsHtml += `<div class="alert alert-warn">\uD83D\uDFE1 <strong>${upcoming.length} upcoming</strong> \u2014 ${fmt(total)} due soon</div>`;
  }
  if (supOwed.length > 0) {
    const total = supOwed.reduce((s, r) => s + (r.balance || 0), 0);
    alertsHtml += `<div class="alert alert-warn">\uD83C\uDFED <strong>You owe suppliers</strong> \u2014 ${fmt(total)}</div>`;
  }
  if (!alertsHtml) alertsHtml = '<div class="alert alert-success">\u2705 No outstanding alerts</div>';
  document.getElementById('alerts-area').innerHTML = alertsHtml;

  // Low stock
  const lsEl = document.getElementById('low-stock-list');
  if (lowStock.length === 0) {
    lsEl.innerHTML = '<div class="empty" style="padding:16px"><div class="empty-text">\u2705 All stock levels OK</div></div>';
  } else {
    lsEl.innerHTML = lowStock.slice(0, 6).map(p => {
      const badge = p.stock <= 0
        ? '<span class="li-badge badge-out">Out</span>'
        : '<span class="li-badge badge-low">Low</span>';
      return `<div class="list-item">
        <div class="li-icon" style="background:var(--warning-bg)">\uD83D\uDCE6</div>
        <div class="li-body"><div class="li-title">${esc(p.name)}</div><div class="li-sub">${p.category || '\u2014'}</div></div>
        <div class="li-right"><div class="li-val" style="color:var(--danger)">${p.stock || 0} ${p.unit || ''}</div>${badge}</div>
      </div>`;
    }).join('');
  }
}

function setKPI(id, val, prefix) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (prefix ? `<span style="font-size:10px;font-weight:600;color:var(--muted)">${prefix} </span>` : '') + val;
}

// ─── SALE HELPERS ─────────────────────────────────────────────
let salesFilter = 'all';

function filterSales(f, btn) {
  salesFilter = f;
  document.querySelectorAll('#page-sales .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderSales();
}

// UTF-8 FIX: badge label strings are plain ASCII — no encoding issues.
function saleListItem(s) {
  const ov    = isOverdue(s);
  // These string literals are pure ASCII — no special chars that
  // could be mangled by font rendering or encoding pipelines.
  const badge = s.status === 'PAID' ? 'badge-paid'
              : ov                  ? 'badge-overdue'
              : s.status === 'PARTIAL' ? 'badge-partial'
              : 'badge-unpaid';
  const label = s.status === 'PAID' ? 'Paid'
              : ov                  ? 'Overdue'
              : s.status === 'PARTIAL' ? 'Partial'
              : 'Unpaid';
  const color = s.status === 'PAID' ? 'var(--success)'
              : ov                  ? 'var(--danger)'
              : 'var(--accent)';
  return `<div class="list-item" onclick="viewSale('${s.id}')">
    <div class="li-icon" style="background:var(--primary-dim)">\uD83E\uDDFE</div>
    <div class="li-body">
      <div class="li-title">${esc(s.product || '\u2014')} \xD7 ${s.qty || 1}</div>
      <div class="li-sub">${esc(s.customer || 'Walk-in')} \xB7 ${fmtDate(s.date)}</div>
    </div>
    <div class="li-right">
      <div class="li-val" style="color:${color}">${fmt(s.total)}</div>
      <div><span class="li-badge ${badge}">${label}</span></div>
    </div>
  </div>`;
}

function renderSales() {
  const q   = (document.getElementById('sales-search')?.value || '').toLowerCase();
  const now = new Date();
  let list  = DB.sales.filter(s => {
    if (q && !s.product?.toLowerCase().includes(q) && !s.customer?.toLowerCase().includes(q) && !s.id?.toLowerCase().includes(q)) return false;
    if (salesFilter === 'paid')    return s.status === 'PAID';
    if (salesFilter === 'unpaid')  return s.status !== 'PAID' && !isOverdue(s);
    if (salesFilter === 'overdue') return isOverdue(s);
    return true;
  });
  list = [...list].reverse();
  const el = document.getElementById('sales-list');
  if (!el) return;
  if (list.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">\uD83E\uDDFE</div><div class="empty-text">No sales found</div></div>';
    return;
  }
  el.innerHTML = list.map(s => `<div class="card" style="padding:0;overflow:hidden">${saleListItem(s)}</div>`).join('');
}

// ─── SALE DETAIL ──────────────────────────────────────────────
function viewSale(id) {
  const s = DB.sales.find(x => x.id === id); if (!s) return;
  currentSaleId = id;
  const ov    = isOverdue(s);
  const badge = s.status === 'PAID'    ? 'badge-paid'
              : ov                     ? 'badge-overdue'
              : s.status === 'PARTIAL' ? 'badge-partial'
              : 'badge-unpaid';
  const label = s.status === 'PAID'    ? 'Paid'
              : ov                     ? 'Overdue'
              : s.status === 'PARTIAL' ? 'Partial'
              : 'Unpaid';
  document.getElementById('sale-detail-content').innerHTML = `
    <div class="flex flex-center gap-8 justify-between" style="margin-bottom:16px">
      <div><div style="font-size:18px;font-weight:700">${esc(s.product)}</div>
           <div style="color:var(--muted);font-size:13px">${s.id} \xB7 ${fmtDate(s.date)}</div></div>
      <span class="li-badge ${badge}" style="font-size:12px">${label}</span>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="form-preview-row"><span class="lbl">Customer</span><span class="val">${esc(s.customer || 'Walk-in')}</span></div>
      <div class="form-preview-row"><span class="lbl">Phone</span><span class="val">${s.phone || '\u2014'}</span></div>
      <div class="form-preview-row"><span class="lbl">Qty</span><span class="val">${s.qty} \xD7 ${fmt(s.unitPrice)}</span></div>
      ${s.discount > 0 ? `<div class="form-preview-row"><span class="lbl">Discount</span><span class="val">${s.discount}%</span></div>` : ''}
      <div class="form-preview-row"><span class="lbl">Subtotal</span><span class="val">${fmt(s.subtotal)}</span></div>
      ${(s.tax || 0) > 0 ? `<div class="form-preview-row"><span class="lbl">Tax</span><span class="val">${fmt(s.tax)}</span></div>` : ''}
      <div class="form-preview-row"><span class="lbl fw-bold">Total</span><span class="val fw-bold">${fmt(s.total)}</span></div>
      <div class="divider"></div>
      <div class="form-preview-row"><span class="lbl">Paid</span><span class="val text-success">${fmt(s.paid)}</span></div>
      <div class="form-preview-row"><span class="lbl">Balance</span><span class="val text-danger fw-bold">${fmt(s.balance)}</span></div>
      <div class="form-preview-row"><span class="lbl">Due Date</span><span class="val ${ov ? 'text-danger' : ''}">${fmtDate(s.dueDate)}</span></div>
      <div class="form-preview-row"><span class="lbl">Payment</span><span class="val">${s.method || '\u2014'}</span></div>
      <div class="form-preview-row"><span class="lbl">Profit</span><span class="val text-success">${fmt(s.grossProfit || 0)}</span></div>
      ${s.notes ? `<div class="form-preview-row"><span class="lbl">Notes</span><span class="val">${esc(s.notes)}</span></div>` : ''}
    </div>`;
  openModal('modal-sale-detail');
}

async function markSalePaid() {
  const s = DB.sales.find(x => x.id === currentSaleId); if (!s) return;
  if (s.status === 'PAID') { toast('Already marked as paid'); return; }
  s.paid    = s.total;
  s.balance = 0;
  s.status  = 'PAID';
  const cust = DB.customers.find(c => c.name === s.customer);
  if (cust) {
    cust.paid    = (cust.paid || 0) + (s.balance || 0);
    cust.balance = Math.max(0, cust.balance - (s.balance || 0));
  }
  BizDB.save();
  closeModal(); renderAll();
  toast('Sale marked as PAID \u2713');
}

// ─── INVOICE ─────────────────────────────────────────────────
function printInvoice() {
  const s = DB.sales.find(x => x.id === currentSaleId); if (!s) return;
  const cfg = DB.settings;
  const html = `
  <div class="invoice-sheet">
    <div class="invoice-header">
      <div><div style="font-size:20px;font-weight:800;color:var(--primary)">${esc(cfg.bizName)}</div>
           <div style="color:var(--muted);font-size:12px">${cfg.type || ''}</div></div>
      <div style="text-align:right">
        <div style="font-size:22px;font-weight:800;color:var(--primary-light)">INVOICE</div>
        <div style="font-size:12px;color:var(--muted)">${s.id}</div>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:16px;font-size:12px">
      <div><strong>Bill To:</strong><br>${esc(s.customer || 'Walk-in')}<br>${s.phone || ''}</div>
      <div style="text-align:right"><strong>Date:</strong> ${fmtDate(s.date)}<br><strong>Due:</strong> ${fmtDate(s.dueDate)}</div>
    </div>
    <table class="invoice-table">
      <thead><tr><th>Product</th><th>Qty</th><th>Price</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>
        <tr>
          <td>${esc(s.product || '\u2014')}${s.category ? `<br><small style="color:var(--muted)">${s.category}</small>` : ''}${s.discount > 0 ? `<br><small style="color:var(--success)">Discount: ${s.discount}%</small>` : ''}</td>
          <td>${s.qty}</td><td>${fmt(s.unitPrice)}</td>
          <td style="text-align:right">${fmt(s.subtotal)}</td>
        </tr>
      </tbody>
    </table>
    <table class="invoice-totals">
      ${(s.tax || 0) > 0 ? `<tr><td>Tax</td><td>${fmt(s.tax)}</td></tr>` : ''}
      <tr style="font-size:15px"><td><strong>Total</strong></td><td><strong>${fmt(s.total)}</strong></td></tr>
      <tr style="color:var(--success)"><td>Paid</td><td>${fmt(s.paid)}</td></tr>
      <tr style="color:${s.balance > 0 ? 'var(--danger)' : 'var(--success)'};font-weight:700"><td>Balance</td><td>${fmt(s.balance)}</td></tr>
    </table>
    <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:12px;font-size:11px;color:var(--muted)">
      Payment Method: ${s.method || '\u2014'} \xB7 ${cfg.invoiceFooter || 'Thank you for your business!'}
    </div>
  </div>`;
  document.getElementById('invoice-content').innerHTML = html;
  closeModal();
  openModal('modal-invoice');
}

// ─── INVENTORY ────────────────────────────────────────────────
function renderInventory() {
  const q    = (document.getElementById('inv-search')?.value || '').toLowerCase();
  const list = DB.inventory.filter(p => !q || p.name?.toLowerCase().includes(q) || p.category?.toLowerCase().includes(q));
  const el   = document.getElementById('inv-list'); if (!el) return;
  if (list.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">\uD83D\uDCE6</div><div class="empty-text">No products yet</div><div class="empty-sub">Tap "Add / Restock Product" to begin</div></div>';
    return;
  }
  const threshold = DB.settings.lowStock || 5;
  el.innerHTML = list.map(p => {
    const st = p.stock || 0, re = p.reorder || threshold;
    const badge = st <= 0
      ? '<span class="li-badge badge-out">Out of stock</span>'
      : st <= re
        ? '<span class="li-badge badge-low">Low stock</span>'
        : '<span class="li-badge badge-paid">In stock</span>';
    const bgIcon = st <= 0 ? 'var(--danger-bg)' : st <= re ? 'var(--warning-bg)' : 'var(--success-bg)';
    return `<div class="card" style="padding:14px 16px;cursor:pointer" onclick="editProduct('${p.id}')">
      <div class="list-item" style="padding:0;border:none">
        <div class="li-icon" style="background:${bgIcon}">\uD83D\uDCE6</div>
        <div class="li-body">
          <div class="li-title">${esc(p.name)}</div>
          <div class="li-sub">${p.category || '\u2014'} \xB7 Cost: ${fmt(p.costPrice || 0)} \xB7 Sell: ${fmt(p.sellPrice || 0)}</div>
        </div>
        <div class="li-right">
          <div class="li-val">${st} <small style="font-size:10px;color:var(--muted)">${p.unit || 'pcs'}</small></div>
          ${badge}
        </div>
      </div>
    </div>`;
  }).join('');
}

function populateRestockDropdown() {
  const sel = document.getElementById('rst-existing'); if (!sel) return;
  sel.innerHTML = '<option value="">\u2014 choose product \u2014</option>' +
    DB.inventory.map(p => `<option value="${p.id}">${esc(p.name)} (stock: ${p.stock || 0})</option>`).join('');
}

function fillRestockInfo() {
  const id = document.getElementById('rst-existing').value;
  const p  = DB.inventory.find(x => x.id === id);
  if (!p) { document.getElementById('rst-existing-info').style.display = 'none'; return; }
  document.getElementById('rst-stock-info').textContent = `Current stock: ${p.stock || 0} ${p.unit || 'pcs'} \xB7 Cost: ${fmt(p.costPrice || 0)} \xB7 Sell: ${fmt(p.sellPrice || 0)}`;
  document.getElementById('rst-new-cost').placeholder = `Current: ${fmt(p.costPrice || 0)}`;
  document.getElementById('rst-new-sell').placeholder = `Current: ${fmt(p.sellPrice || 0)}`;
  document.getElementById('rst-existing-info').style.display = 'block';
}

function editProduct(id) {
  openModal('modal-restock');
  rstTab('restock', document.querySelectorAll('#modal-restock .tab-btn')[1]);
  populateRestockDropdown();
  const sel = document.getElementById('rst-existing');
  sel.value = id;
  fillRestockInfo();
}

// ─── EXPENSES & SUPPLIERS ────────────────────────────────────
let expTab = 'list';

function showExpTab(tab, btn) {
  expTab = tab;
  document.querySelectorAll('#page-expenses .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('#page-expenses .tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('exp-tab-' + tab)?.classList.add('active');
  if (tab === 'list')      renderExpenses();
  if (tab === 'suppliers') renderSuppliers();
}

function renderExpenses() {
  const list = [...DB.expenses].reverse();
  const el   = document.getElementById('exp-list'); if (!el) return;
  if (list.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">\uD83D\uDCB8</div><div class="empty-text">No expenses yet</div></div>';
    return;
  }
  el.innerHTML = list.map(e => `
    <div class="card" style="padding:12px 14px">
      <div class="list-item" style="padding:0;border:none">
        <div class="li-icon" style="background:var(--danger-bg)">\uD83D\uDCB8</div>
        <div class="li-body">
          <div class="li-title">${esc(e.description || e.category)}</div>
          <div class="li-sub">${e.category} \xB7 ${fmtDate(e.date)} \xB7 ${e.method || 'Cash'}</div>
        </div>
        <div class="li-right"><div class="li-val text-danger">${fmt(e.amount)}</div></div>
      </div>
    </div>`).join('');
}

function renderSuppliers() {
  const el = document.getElementById('sup-list'); if (!el) return;
  if (DB.suppliers.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">\uD83C\uDFED</div><div class="empty-text">No suppliers yet</div></div>';
    return;
  }
  el.innerHTML = DB.suppliers.map(s => `
    <div class="card" style="padding:12px 14px">
      <div class="list-item" style="padding:0;border:none">
        <div class="li-icon" style="background:var(--accent-light)">\uD83C\uDFED</div>
        <div class="li-body">
          <div class="li-title">${esc(s.name)} <small style="color:var(--muted);font-size:10px">${s.id}</small></div>
          <div class="li-sub">${s.phone || '\u2014'} \xB7 ${esc(s.products || '\u2014')}</div>
        </div>
        <div class="li-right">
          <div class="li-val ${(s.balance || 0) > 0 ? 'text-danger' : 'text-success'}">${fmt(s.balance || 0)}</div>
          <div class="li-badge ${(s.balance || 0) > 0 ? 'badge-overdue' : 'badge-paid'}">${(s.balance || 0) > 0 ? 'Owes' : 'Clear'}</div>
        </div>
      </div>
    </div>`).join('');
}

// ─── FORM SUBMISSIONS ─────────────────────────────────────────
async function submitSale() {
  const product  = val('s-product').trim();
  const qty      = parseFloat(val('s-qty'))  || 0;
  const price    = parseFloat(val('s-price')) || 0;
  if (!product) { toast('\u274C Product name is required'); return; }
  if (qty <= 0) { toast('\u274C Quantity must be > 0');    return; }
  if (price <= 0) { toast('\u274C Unit price must be > 0'); return; }

  const costPr   = parseFloat(val('s-cost'))     || 0;
  const discount = parseFloat(val('s-discount'))  || 0;
  const paid     = parseFloat(val('s-paid'))      || 0;
  const cfg      = DB.settings;
  const subtotal = qty * price * (1 - discount / 100);
  const tax      = subtotal * (cfg.taxRate / 100);
  const total    = subtotal + tax;
  const balance  = Math.max(0, total - paid);
  const status   = balance <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
  const dueDate  = (() => { const d = new Date(); d.setDate(d.getDate() + (cfg.payTerms || 30)); return d.toISOString().slice(0, 10); })();
  const grossProfit = subtotal - (qty * costPr);

  const inv  = DB.inventory.find(p => p.name.toLowerCase() === product.toLowerCase());
  const sale = {
    id:           nextId('SL-', DB.sales),
    date:         new Date().toISOString(),
    customer:     val('s-customer').trim() || 'Walk-in',
    phone:        val('s-phone').trim(),
    product, qty, unitPrice: price,
    category:     inv?.category || '',
    discount, subtotal, tax, total,
    paid, balance, status, dueDate,
    method:       val('s-method'),
    grossProfit,
    costPrice:    costPr,
    notes:        val('s-notes').trim()
  };

  DB.sales.push(sale);
  if (inv) { inv.stock = Math.max(0, (inv.stock || 0) - qty); }
  upsertCustomer(sale.customer, sale.phone, total, paid, sale.date);
  BizDB.save();

  // Reset form
  ['s-product','s-qty','s-price','s-cost','s-discount','s-paid','s-customer','s-phone','s-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 's-qty' ? '1' : id === 's-discount' ? '0' : '';
  });
  document.getElementById('sale-preview').style.display    = 'none';
  document.getElementById('balance-preview').style.display = 'none';
  closeModal(); renderAll();
  toast(`\u2705 Sale ${sale.id} saved! ${status} \xB7 ${fmt(total)}`);
}

async function submitProduct() {
  const name = val('rst-name').trim();
  const cost = parseFloat(val('rst-cost')) || 0;
  const sell = parseFloat(val('rst-sell')) || 0;
  const qty  = parseFloat(val('rst-qty'))  || 0;
  if (!name)           { toast('\u274C Product name required');               return; }
  if (cost <= 0 || sell <= 0) { toast('\u274C Enter cost and selling price'); return; }
  if (qty < 0)         { toast('\u274C Stock cannot be negative');            return; }
  if (DB.inventory.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    toast('Product already exists \u2014 use Restock tab'); return;
  }
  DB.inventory.push({
    id:         nextId('PRD-', DB.inventory),
    name,
    category:   val('rst-category') || 'Other',
    unit:       val('rst-unit') || 'pcs',
    costPrice:  cost, sellPrice: sell,
    stock:      qty,
    reorder:    parseFloat(val('rst-reorder')) || 5,
    supplier:   val('rst-supplier') || '',
    notes:      val('rst-notes') || '',
    created:    new Date().toISOString()
  });
  BizDB.save(); closeModal(); renderAll();
  toast(`\u2705 Product "${name}" added`);
}

async function submitRestock() {
  const id  = val('rst-existing'); if (!id) { toast('\u274C Select a product'); return; }
  const qty = parseFloat(val('rst-add-qty')) || 0; if (qty <= 0) { toast('\u274C Enter quantity to add'); return; }
  const p   = DB.inventory.find(x => x.id === id); if (!p) return;
  p.stock   = (p.stock || 0) + qty;
  const nc  = parseFloat(val('rst-new-cost')) || 0;
  const ns  = parseFloat(val('rst-new-sell')) || 0;
  if (nc > 0) p.costPrice = nc;
  if (ns > 0) p.sellPrice = ns;
  p.lastUpdated = new Date().toISOString();
  BizDB.save(); closeModal(); renderAll();
  toast(`\u2705 Restocked: ${p.name} \u2014 ${p.stock} ${p.unit || 'pcs'} now in stock`);
}

async function submitExpense() {
  const desc = val('e-desc').trim();
  const amt  = parseFloat(val('e-amount')) || 0;
  if (!desc) { toast('\u274C Description required'); return; }
  if (amt <= 0) { toast('\u274C Amount must be > 0'); return; }
  DB.expenses.push({
    id:          nextId('EXP-', DB.expenses),
    date:        new Date().toISOString(),
    category:    val('e-category'),
    description: desc,
    amount:      amt,
    method:      val('e-method'),
    supplier:    val('e-supplier'),
    receipt:     val('e-receipt'),
    notes:       val('e-notes')
  });
  BizDB.save();
  ['e-desc','e-amount','e-supplier','e-receipt','e-notes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  closeModal(); renderExpenses(); renderDashboard();
  toast(`\u2705 Expense saved \u2014 ${fmt(amt)}`);
}

async function submitSupplier() {
  const name  = val('sup-name').trim();
  const phone = val('sup-phone').trim();
  if (!name) { toast('\u274C Supplier name required'); return; }
  const debt = parseFloat(val('sup-debt')) || 0;
  DB.suppliers.push({
    id:       nextId('SUP-', DB.suppliers),
    name, contact: val('sup-contact'), phone,
    products: val('sup-products'),
    balance:  debt, owed: debt, paid: 0,
    due:      val('sup-due'),
    notes:    val('sup-notes'),
    created:  new Date().toISOString()
  });
  BizDB.save();
  ['sup-name','sup-contact','sup-phone','sup-products','sup-debt','sup-due','sup-notes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  closeModal(); renderSuppliers();
  toast(`\u2705 Supplier "${name}" added`);
}

async function submitReturn() {
  const saleId  = val('ret-saleid').trim().toUpperCase();
  const product = val('ret-product').trim();
  const qty     = parseFloat(val('ret-qty'))    || 0;
  const refund  = parseFloat(val('ret-refund')) || 0;
  if (!saleId)   { toast('\u274C Sale ID required');           return; }
  if (!product)  { toast('\u274C Product name required');      return; }
  if (qty <= 0)  { toast('\u274C Quantity must be > 0');       return; }
  if (refund <= 0) { toast('\u274C Refund amount must be > 0'); return; }
  const ret = {
    id:      nextId('RET-', DB.returns),
    date:    new Date().toISOString(),
    saleId, product, qty, refund,
    type:    val('ret-type'),
    restock: val('ret-restock'),
    reason:  val('ret-reason')
  };
  DB.returns.push(ret);
  if (ret.restock === 'YES') {
    const inv = DB.inventory.find(p => p.name.toLowerCase() === product.toLowerCase());
    if (inv) inv.stock = (inv.stock || 0) + qty;
  }
  BizDB.save();
  ['ret-saleid','ret-product','ret-qty','ret-refund','ret-reason'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  closeModal(); renderAll();
  toast(`\u2705 Return ${ret.id} processed \u2014 refund ${fmt(refund)}`);
}

// ─── CUSTOMER LEDGER ─────────────────────────────────────────
function upsertCustomer(name, phone, total, paid, date) {
  let c = DB.customers.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!c) {
    c = { name, phone: '', email: '', billed: 0, paid: 0, balance: 0, lastPurchase: '', transactions: 0 };
    DB.customers.push(c);
  }
  if (phone && !c.phone) c.phone = phone;
  c.billed       = (c.billed  || 0) + total;
  c.paid         = (c.paid    || 0) + paid;
  c.balance      = Math.max(0, c.billed - c.paid);
  c.lastPurchase = date;
  c.transactions = (c.transactions || 0) + 1;
}

// ─── LIVE SALE PREVIEW ────────────────────────────────────────
function updateSalePreview() {
  const qty   = parseFloat(val('s-qty'))      || 0;
  const price = parseFloat(val('s-price'))    || 0;
  const cost  = parseFloat(val('s-cost'))     || 0;
  const disc  = parseFloat(val('s-discount')) || 0;
  const paid  = parseFloat(val('s-paid'))     || 0;
  if (price <= 0 || qty <= 0) {
    document.getElementById('sale-preview').style.display    = 'none';
    document.getElementById('balance-preview').style.display = 'none';
    return;
  }
  const sub    = qty * price * (1 - disc / 100);
  const profit = sub - (qty * cost);
  const margin = sub > 0 ? (profit / sub * 100) : 0;
  const bal    = Math.max(0, sub - paid);
  const status = bal <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
  document.getElementById('prev-subtotal').textContent = fmt(sub);
  document.getElementById('prev-profit').textContent   = cost > 0 ? fmt(profit) : '(enter cost price)';
  document.getElementById('prev-margin').textContent   = cost > 0 ? margin.toFixed(1) + '%' : '\u2014';
  document.getElementById('sale-preview').style.display    = 'block';
  document.getElementById('prev-balance').textContent  = fmt(bal);
  document.getElementById('prev-status').textContent   = status;
  document.getElementById('balance-preview').style.display = 'block';
}

function updateRestockPreview() {
  const cost = parseFloat(val('rst-cost')) || 0;
  const sell = parseFloat(val('rst-sell')) || 0;
  if (cost <= 0 || sell <= 0) { document.getElementById('restock-preview').style.display = 'none'; return; }
  const profit = sell - cost;
  const margin = sell > 0 ? (profit / sell * 100) : 0;
  document.getElementById('rst-prev-profit').textContent = fmt(profit) + ' per unit';
  document.getElementById('rst-prev-margin').textContent = margin.toFixed(1) + '%';
  document.getElementById('restock-preview').style.display = 'block';
}

function onProductInput() {
  const name = val('s-product').toLowerCase();
  const inv  = DB.inventory.find(p => p.name.toLowerCase() === name);
  if (inv) {
    document.getElementById('s-price').value = inv.sellPrice || '';
    document.getElementById('s-cost').value  = inv.costPrice || '';
    const st   = inv.stock || 0, re = inv.reorder || DB.settings.lowStock || 5;
    const hint = st <= 0 ? '\u26A0\uFE0F OUT OF STOCK' : st <= re ? `\u26A0\uFE0F Low stock: ${st} ${inv.unit || 'pcs'} left` : `Stock: ${st} ${inv.unit || 'pcs'}`;
    const col  = st <= 0 ? 'var(--danger)' : st <= re ? 'var(--warning)' : 'var(--success)';
    const h    = document.getElementById('s-product-hint');
    if (h) { h.textContent = hint; h.style.color = col; }
    updateSalePreview();
  } else {
    const h = document.getElementById('s-product-hint');
    if (h) h.textContent = '';
  }
}

// ─── DATALISTS ────────────────────────────────────────────────
function populateDatalists() {
  const pdl = document.getElementById('product-datalist');
  const cdl = document.getElementById('customer-datalist');
  if (pdl) pdl.innerHTML = DB.inventory.map(p => `<option value="${esc(p.name)}">`).join('');
  if (cdl) cdl.innerHTML = [...new Set(DB.sales.map(s => s.customer))].map(n => `<option value="${esc(n)}">`).join('');
}

// ─── REPORTS ─────────────────────────────────────────────────
function rptRange(r) {
  const n = new Date();
  let sd, ed;
  if (r === 'today') {
    sd = today(); ed = today();
  } else if (r === 'week') {
    const d = new Date(); d.setDate(d.getDate() - d.getDay());
    sd = d.toISOString().slice(0, 10); ed = today();
  } else if (r === 'month') {
    sd = new Date(n.getFullYear(), n.getMonth(), 1).toISOString().slice(0, 10); ed = today();
  } else {
    sd = new Date(n.getFullYear(), 0, 1).toISOString().slice(0, 10); ed = today();
  }
  const f = document.getElementById('rpt-from'); if (f) f.value = sd;
  const t = document.getElementById('rpt-to');   if (t) t.value = ed;
}

function buildReport() {
  const sd = new Date(document.getElementById('rpt-from').value); sd.setHours(0,  0,  0,   0);
  const ed = new Date(document.getElementById('rpt-to').value);   ed.setHours(23, 59, 59, 999);
  if (isNaN(sd) || isNaN(ed)) { toast('\u274C Select date range'); return; }

  const sales = DB.sales.filter(s  => { const d = new Date(s.date);  return d >= sd && d <= ed; });
  const exps  = DB.expenses.filter(e => { const d = new Date(e.date); return d >= sd && d <= ed; });
  const rets  = DB.returns.filter(r  => { const d = new Date(r.date); return d >= sd && d <= ed; });

  const revenue  = sales.reduce((s, r) => s + (r.total || 0), 0);
  const coll     = sales.reduce((s, r) => s + (r.paid  || 0), 0);
  const cogs     = sales.reduce((s, r) => s + ((r.qty  || 0) * (r.costPrice || 0)), 0);
  const grossP   = revenue - cogs;
  const totalExp = exps.reduce((s, r) => s + (r.amount || 0), 0);
  const netP     = grossP - totalExp;
  const refunds  = rets.reduce((s, r) => s + (r.refund || 0), 0);
  const overdue  = sales.filter(s => isOverdue(s) && s.balance > 0).reduce((s, r) => s + (r.balance || 0), 0);
  const upcoming = sales.filter(s => !isOverdue(s) && s.status !== 'PAID' && s.balance > 0).reduce((s, r) => s + (r.balance || 0), 0);
  const cr = revenue > 0 ? ((coll / revenue) * 100).toFixed(1) : '0.0';
  const gm = revenue > 0 ? ((grossP / revenue) * 100).toFixed(1) : '0.0';
  const nm = revenue > 0 ? ((netP / revenue) * 100).toFixed(1) : '0.0';

  const cats = {};
  sales.forEach(s => {
    const c = s.category || 'Uncategorised';
    if (!cats[c]) cats[c] = { rev: 0, qty: 0 };
    cats[c].rev += (s.total || 0); cats[c].qty += (s.qty || 0);
  });
  const catRows = Object.entries(cats).sort((a, b) => b[1].rev - a[1].rev)
    .map(([c, d]) => `<tr><td>${esc(c)}</td><td>${d.qty}</td><td>${fmt(d.rev)}</td></tr>`).join('');

  const methods = {};
  sales.forEach(s => { const m = s.method || 'Cash'; methods[m] = (methods[m] || 0) + (s.paid || 0); });
  const pmRows = Object.entries(methods).sort((a, b) => b[1] - a[1])
    .map(([m, v]) => `<tr><td>${m}</td><td>${fmt(v)}</td><td>${coll > 0 ? ((v / coll) * 100).toFixed(1) : 0}%</td></tr>`).join('');

  const tbl = (h, rows) => `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:10px">
    <thead><tr style="background:var(--primary);color:#fff">${h.map(c => `<th style="padding:8px;text-align:left">${c}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>`;

  const pl = (label, val, color) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px">
    <span style="color:var(--text-2)">${label}</span>
    <strong style="font-family:var(--mono);color:${color || 'var(--text)'}">${fmt(val)}</strong></div>`;

  const el = document.getElementById('report-output');
  el.innerHTML = `
  <div class="card">
    <div class="card-title">\uD83D\uDCCA Report \xB7 ${fmtDate(sd)} \u2013 ${fmtDate(ed)}</div>
    <div class="mt-12">
      <div style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;margin-bottom:6px">Revenue &amp; Collections</div>
      ${pl('Total Revenue', revenue)}
      ${pl('Total Collected', coll, 'var(--success)')}
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px">
        <span style="color:var(--text-2)">Collection Rate</span><strong style="color:var(--success)">${cr}%</strong></div>
      ${pl('Total Refunds Issued', -refunds, 'var(--danger)')}
    </div>
    <div class="mt-12">
      <div style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;margin-bottom:6px">Profit &amp; Loss</div>
      ${pl('Cost of Goods Sold', -cogs, 'var(--danger)')}
      ${pl('Gross Profit', grossP, grossP >= 0 ? 'var(--success)' : 'var(--danger)')}
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--muted)">Gross Margin</span><span style="color:var(--success)">${gm}%</span></div>
      ${pl('Total Expenses', -totalExp, 'var(--danger)')}
      <div style="display:flex;justify-content:space-between;padding:10px 0;font-size:15px">
        <span style="font-weight:700">Net Profit</span>
        <strong style="font-family:var(--mono);color:${netP >= 0 ? 'var(--success)' : 'var(--danger)'}">
          ${fmt(netP)} <span style="font-size:12px;font-weight:400">(${nm}%)</span></strong></div>
    </div>
    <div class="mt-12">
      <div style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;margin-bottom:6px">Debt Position</div>
      ${pl('Overdue Debt', -overdue, 'var(--danger)')}
      ${pl('Upcoming Debt', -upcoming, 'var(--warning)')}
    </div>
  </div>
  ${catRows ? `<div class="card"><div class="card-title">Sales by Category</div>${tbl(['Category', 'Units', 'Revenue'], [catRows])}</div>` : ''}
  ${pmRows  ? `<div class="card"><div class="card-title">Payment Methods</div>${tbl(['Method', 'Collected', '% of Total'], [pmRows])}</div>` : ''}
  <div class="card">
    <div class="card-title">Summary</div>
    <div style="font-size:13px;color:var(--text-2);line-height:1.8">
      Transactions: <strong>${sales.length}</strong> \xB7
      Customers: <strong>${[...new Set(sales.map(s => s.customer))].length}</strong> \xB7
      Products sold: <strong>${sales.reduce((s, r) => s + (r.qty || 0), 0)}</strong>
    </div>
  </div>`;
}

// ─── SETTINGS ────────────────────────────────────────────────
function loadSettingsForm() {
  const s = DB.settings;
  setVal('s-bizname', s.bizName);
  setVal('s-owner',   s.owner   || '');
  setVal('s-type',    s.type    || '');
  setVal('s-currency', s.currency || 'UGX');
  setVal('s-terms',   s.payTerms  || 30);
  setVal('s-lowstock', s.lowStock || 5);
  setVal('s-tax',     s.taxRate   || 0);
  setVal('s-footer',  s.invoiceFooter || '');
}

async function saveSettings() {
  DB.settings.bizName       = val('s-bizname');
  DB.settings.owner         = val('s-owner');
  DB.settings.type          = val('s-type');
  DB.settings.currency      = val('s-currency');
  DB.settings.payTerms      = parseInt(val('s-terms'))   || 30;
  DB.settings.lowStock      = parseInt(val('s-lowstock')) || 5;
  DB.settings.taxRate       = parseFloat(val('s-tax'))   || 0;
  DB.settings.invoiceFooter = val('s-footer');
  BizDB.save(); renderAll();
  document.getElementById('h-bizname').textContent = DB.settings.bizName;
  toast('Settings saved \u2713');
}

async function clearAllData() {
  if (!confirm('Delete ALL data permanently? This cannot be undone.\n\nMake sure you have a backup first.')) return;
  if (!confirm('Are you absolutely sure? ALL sales, inventory, and expenses will be lost.')) return;
  DB.sales = []; DB.inventory = []; DB.suppliers = [];
  DB.customers = []; DB.expenses = []; DB.returns = [];
  await BizDB.save(); renderAll(); toast('All data cleared');
}

function openBackup() { openModal('modal-backup'); }

// ─── EXPORT / IMPORT JSON ────────────────────────────────────
function exportJSON() {
  const data  = BizDB.exportJSON();
  const blob  = new Blob([data], { type: 'application/json;charset=utf-8' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  const d     = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `biztrack_backup_${d}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('Backup downloaded \u2713');
}

async function importJSON(evt) {
  const file = evt.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    if (!confirm('This will REPLACE all your current data. Are you sure?')) return;
    try {
      await BizDB.importJSON(e.target.result);
      renderAll();
      toast('Data imported successfully \u2713');
    } catch (err) {
      alert('Invalid backup file. Please use a BizTrack JSON backup.');
    }
  };
  // Use UTF-8 explicitly — fixes any "square character" encoding issues
  reader.readAsText(file, 'UTF-8');
  evt.target.value = '';
}

// ─── DESKTOP NAV SETUP ────────────────────────────────────────
function setupDesktopNav() {
  const isDesktop = window.innerWidth >= 768;
  const logo   = document.getElementById('nav-logo');
  const inner  = document.getElementById('nav-inner');
  const bottom = document.getElementById('nav-bottom');
  if (isDesktop) {
    logo.style.display   = 'flex';
    inner.style.display  = 'block';
    bottom.style.display = 'block';
    if (!document.querySelector('#nav .reports-btn')) {
      const reportBtn = document.createElement('button');
      reportBtn.className = 'nav-btn reports-btn';
      reportBtn.onclick   = () => showPage('reports');
      reportBtn.innerHTML = '<span class="icon">\uD83D\uDCC8</span><span>Reports</span><span class="nav-dot"></span>';
      const settBtn = document.createElement('button');
      settBtn.className = 'nav-btn settings-btn';
      settBtn.onclick   = () => showPage('settings');
      settBtn.innerHTML = '<span class="icon">\u2699\uFE0F</span><span>Settings</span><span class="nav-dot"></span>';
      inner.appendChild(reportBtn);
      inner.appendChild(settBtn);
    }
  }
}

// ─── TAB HELPERS ─────────────────────────────────────────────
function rstTab(tab, btn) {
  document.querySelectorAll('#modal-restock .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('rst-panel-new').className     = 'tab-panel' + (tab === 'new'     ? ' active' : '');
  document.getElementById('rst-panel-restock').className = 'tab-panel' + (tab === 'restock' ? ' active' : '');
}

// ─── UTILS ───────────────────────────────────────────────────
const val    = id => { const el = document.getElementById(id); return el ? el.value : ''; };
const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
const esc    = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let toastTimer;
function toast(msg, duration = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ─── INIT ─────────────────────────────────────────────────────
// Must be async to await BizDB.init() before rendering the app.
window.addEventListener('DOMContentLoaded', async () => {

  // 1. Initialise SQLite (or localStorage fallback)
  await BizDB.init();

  // 2. Hide loading screen
  const ls = document.getElementById('loading-screen');
  if (ls) {
    ls.classList.add('hidden');
    setTimeout(() => ls.remove(), 400);
  }

  // 3. Show app or onboarding
  if (DB.settings.bizName && DB.settings.bizName !== 'My Business') {
    document.getElementById('onboard').classList.add('gone');
    document.getElementById('h-bizname').textContent = DB.settings.bizName;
    renderAll();
  } else {
    // Show onboarding
    document.getElementById('onboard').classList.remove('gone');
  }

  // 4. Set default report dates
  rptRange('month');

  // 5. Desktop nav
  setupDesktopNav();
  window.addEventListener('resize', setupDesktopNav);

  // 6. Close modal on Escape
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
});
