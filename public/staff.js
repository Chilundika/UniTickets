'use strict';
// Staff dashboard for IT users and SUDO admins.
(function () {
  let cfg = null;          // /api/me response
  let clockOffset = 0;     // server time - browser time
  const isAdmin = () => cfg && cfg.user.role === 'admin';
  const show = (el, on) => (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on);
  const opt = (value, label, selected) => h('option', { value, selected: selected ? true : false }, label ?? value);

  // Any 401 means the session ended (timeout or sign-out elsewhere).
  async function call(url, opts) {
    try { return await api(url, opts); } catch (e) {
      if (e.status === 401 && url !== '/api/login') showLogin('Your session has ended. Please sign in again.');
      throw e;
    }
  }

  // ---------- Clock (server-synchronised, Africa/Lusaka) ----------
  const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lusaka', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  async function syncClock() {
    try { const t0 = Date.now(); const { now } = await api('/api/time'); clockOffset = now + (Date.now() - t0) / 2 - Date.now(); } catch {}
  }
  setInterval(() => { $('#clock').textContent = clockFmt.format(new Date(Date.now() + clockOffset)); }, 1000);
  syncClock();
  setInterval(syncClock, 5 * 60000);

  // ---------- Sign in ----------
  function showLogin(msg) {
    cfg = null;
    ['#app', '#changepw', '#logout', '#bell', '#whoami', '#notifs'].forEach((id) => show(id, false));
    show('#login', true);
    $('#login-err').textContent = msg || '';
    if ($('#dlg').open) $('#dlg').close();
  }
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-err').textContent = '';
    try {
      const r = await api('/api/login', { method: 'POST', body: { username: $('#username').value, password: $('#password').value, code: $('#code').value } });
      if (r.totpSetup) {
        show('#totp-setup', true); show('#code-box', true);
        $('#totp-secret').textContent = r.totpSetup.secret;
        $('#qr-2fa').replaceChildren();
        if (window.QRCode) new QRCode($('#qr-2fa'), { text: r.totpSetup.otpauth, width: 180, height: 180 });
        return $('#code').focus();
      }
      if (r.need2fa) { show('#code-box', true); return $('#code').focus(); }
      $('#password').value = ''; $('#code').value = '';
      show('#totp-setup', false); show('#code-box', false);
      boot();
    } catch (err) {
      $('#login-err').textContent = err.message;
      if (err.data && err.data.need2fa) { $('#code').value = ''; $('#code').focus(); }
    }
  });
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin('You have signed out.'); });

  $('#changepw').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await call('/api/me/password', { method: 'POST', body: { current: $('#cur-pw').value, next: $('#new-pw').value } });
      $('#cur-pw').value = ''; $('#new-pw').value = '';
      boot();
    } catch (err) { $('#pw-err').textContent = err.message; }
  });

  async function boot() {
    try { cfg = await api('/api/me'); } catch { return showLogin(); }
    show('#login', false);
    $('#whoami').textContent = `${cfg.user.username} (${cfg.user.role === 'admin' ? 'SUDO admin' : 'IT user'})`;
    ['#whoami', '#logout', '#bell'].forEach((id) => show(id, true));
    if (cfg.user.mustChangePassword) { show('#changepw', true); show('#app', false); return $('#cur-pw').focus(); }
    show('#changepw', false);
    show('#app', true);
    $$('[data-admin]').forEach((b) => show(b, isAdmin()));
    fillFilters();
    refreshStats();
    loadTickets();
    loadNotifs();
  }

  // ---------- Tabs ----------
  const loaders = { tickets: loadTickets, mine: loadMine, links: loadLinks, reports: loadReports, users: loadUsers, settings: loadSettings, qr: () => {}, audit: loadAudit };
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('#tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b ? 'true' : 'false'));
    $$('[data-panel]').forEach((p) => show(p, p.dataset.panel === b.dataset.tab));
    loaders[b.dataset.tab]();
  });

  // ---------- Stats ----------
  async function refreshStats() {
    if (!cfg) return;
    try {
      const s = await call('/api/stats/today');
      for (const k of ['received', 'completed', 'pending', 'escalation', 'referred']) $(`#s-${k}`).textContent = s[k];
    } catch {}
  }
  setInterval(() => { refreshStats(); loadNotifs(); }, 60000);

  // ---------- Tickets list ----------
  function fillFilters() {
    // Rebuild each select's options but keep the current choice (default: All).
    const fill = (sel, fixed, items) => {
      const el = $(sel);
      const prev = el.value;
      el.replaceChildren(...fixed.map(([v, l]) => opt(v, l)), ...items.map((i) => opt(i.value ?? i, i.label)));
      el.value = [...el.options].some((o) => o.value === prev) ? prev : '';
    };
    const all = [['', 'All']];
    fill('#f-status', all, cfg.statuses);
    fill('#f-category', all, cfg.categories);
    fill('#f-priority', all, cfg.priorities);
    fill('#f-department', all, cfg.departments.map((d) => ({ value: d.code, label: d.code })));
    fill('#f-assignee', [...all, ['me', 'Me'], ['none', 'Unassigned']], cfg.staff.map((u) => ({ value: u.id, label: u.username })));
  }
  function slaChip(t) {
    if (t.status === 'Resolved') return h('span', { class: 'chip' }, 'Done');
    const due = t.created_at + (cfg.slaHours[t.priority] || 24) * 3600000;
    const left = Math.round((due - Date.now()) / 3600000);
    return left < 0 ? h('span', { class: 'chip overdue' }, `Overdue ${-left}h`) : h('span', { class: 'chip' }, `Due in ${left}h`);
  }
  function ticketRow(t) {
    const flags = [];
    if (!t.tracked) flags.push(h('span', { class: 'chip' }, 'Untracked'));
    if (t.duplicate_of) flags.push(h('span', { class: 'chip' }, `Dup of ${t.duplicate_of}`));
    if (t.widespread) flags.push(h('span', { class: 'chip High' }, 'Widespread'));
    return h('tr', { class: 'clickable', onclick: () => openTicket(t.id) },
      h('td', {}, h('button', { type: 'button', class: 'link', onclick: (e) => { e.stopPropagation(); openTicket(t.id); } }, t.number)),
      h('td', {}, t.status),
      h('td', {}, h('span', { class: `chip ${t.priority}` }, t.priority), ' ', slaChip(t)),
      h('td', {}, t.category, t.location ? h('div', { class: 'muted' }, t.location) : null),
      h('td', {}, t.summary, ' ', flags),
      h('td', {}, t.assignee || '—'),
      h('td', {}, when(t.created_at)));
  }
  let filterTimer;
  $('#filters').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(loadTickets, 300); });
  $('#filters').addEventListener('submit', (e) => e.preventDefault());
  async function loadTickets() {
    const q = new URLSearchParams();
    for (const k of ['from', 'to', 'status', 'category', 'priority', 'department', 'assignee', 'q']) { const v = $(`#f-${k}`).value.trim(); if (v) q.set(k, v); }
    try {
      const rows = await call(`/api/tickets?${q}`);
      $('#t-body').replaceChildren(...(rows.length ? rows.map(ticketRow) : [h('tr', {}, h('td', { colspan: 7 }, 'No tickets match.'))]));
    } catch (e) { $('#t-body').replaceChildren(h('tr', {}, h('td', { colspan: 7, class: 'error' }, e.message))); }
  }

  async function loadMine() {
    const s = await call('/api/stats/me');
    const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, n ?? 0), h('span', {}, label));
    $('#my-stats').replaceChildren(stat(s.total, 'Assigned to me'), stat(s.open, 'Open'), stat(s.resolved, 'Resolved'),
      stat(s.avg_hours ? `${s.avg_hours.toFixed(1)}h` : '–', 'Avg. resolution time'));
    const rows = (await call('/api/tickets?assignee=me')).filter((t) => t.status !== 'Resolved');
    $('#my-body').replaceChildren(...(rows.length ? rows.map(ticketRow) : [h('tr', {}, h('td', {}, 'Nothing open. Well done.'))]));
  }

  // ---------- Ticket detail ----------
  $('#dlg-close').addEventListener('click', () => $('#dlg').close());
  async function openTicket(id) {
    let t;
    try { t = await call(`/api/tickets/${encodeURIComponent(id)}`); } catch (e) { return alert(e.message); }
    $('#dlg-title').textContent = `Ticket ${t.number}`;
    const msg = h('p', { 'aria-live': 'polite' });
    const done = async (p) => {
      try { await p; msg.className = 'notice ok'; msg.textContent = 'Saved.'; loadTickets(); refreshStats(); setTimeout(() => openTicket(id), 600); }
      catch (e) { msg.className = 'error'; msg.textContent = e.message; }
    };

    // Update form
    const status = h('select', { id: 'd-status' }, cfg.statuses.filter((s) => s !== 'Referred to Department' || s === t.status).map((s) => opt(s, s, s === t.status)));
    const priority = h('select', { id: 'd-priority' }, cfg.priorities.map((p) => opt(p, p, p === t.priority)));
    const category = h('select', { id: 'd-category' }, cfg.categories.map((c) => opt(c, c, c === t.category)));
    const assignee = h('select', { id: 'd-assignee' }, opt('', 'Unassigned'), cfg.staff.map((u) => opt(u.id, u.username, u.id === t.assigned_to)));
    const note = h('textarea', { id: 'd-note', class: 'short-ta', maxlength: 2000 });
    const canned = h('select', { id: 'd-canned', onchange: () => { if (canned.value) { note.value = canned.value; pub.checked = true; canned.value = ''; } } },
      opt('', 'Insert a canned reply…'), cfg.cannedReplies.map((c) => opt(c, c.length > 60 ? c.slice(0, 60) + '…' : c)));
    const pub = h('input', { type: 'checkbox', id: 'd-public' });
    const update = h('form', { class: 'card', onsubmit: (e) => {
      e.preventDefault();
      done(call(`/api/tickets/${t.id}`, { method: 'PATCH', body: { status: status.value, priority: priority.value, category: category.value, assignedTo: assignee.value ? Number(assignee.value) : null, note: note.value, public: pub.checked } }));
    } },
    h('h3', {}, 'Update'),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'd-status' }, 'Status'), status),
      h('div', {}, h('label', { for: 'd-priority' }, 'Priority'), priority),
      h('div', {}, h('label', { for: 'd-category' }, 'Category'), category),
      h('div', {}, h('label', { for: 'd-assignee' }, 'Assigned to'), assignee)),
    h('label', { for: 'd-note' }, 'Note'), canned, note,
    h('label', { class: 'choice' }, pub, t.tracked ? 'Visible to requester (sent by email/WhatsApp)' : 'Visible to requester (untracked: not sent)'),
    h('p', { class: 'hint' }, 'Unticked notes are internal and never shown to the requester.'),
    h('div', { class: 'actions' },
      h('button', { type: 'submit' }, 'Save'),
      t.assigned_to !== cfg.user.id ? h('button', { type: 'button', class: 'secondary', onclick: () => done(call(`/api/tickets/${t.id}/claim`, { method: 'POST' })) }, 'Claim') : null));

    // Refer form
    const dept = h('select', { id: 'd-dept' }, cfg.departments.map((d) => opt(d.code, `${d.code} – ${d.name}`)));
    const surname = h('input', { id: 'd-surname', type: 'text', maxlength: 40, autocomplete: 'off' });
    const desc = h('textarea', { id: 'd-desc', class: 'short-ta', maxlength: 1000 });
    const linkOut = h('p', { class: 'muted' });
    const refer = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await call(`/api/tickets/${t.id}/refer`, { method: 'POST', body: { department: dept.value, surname: surname.value, description: desc.value } });
        linkOut.className = 'notice ok';
        linkOut.textContent = r.url ? `Referred. Link emailed to the department (expires ${r.expires}): ${r.url}` : `Referred. Added to the existing link for this person (expires ${r.expires}).`;
        loadTickets(); refreshStats();
      } catch (err) { linkOut.className = 'error'; linkOut.textContent = err.message; }
    } },
    h('h3', {}, 'Refer to department (not an IT issue)'),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'd-dept' }, 'Department'), dept),
      h('div', {}, h('label', { for: 'd-surname' }, 'Recipient surname'), surname)),
    h('label', { for: 'd-desc' }, 'Description for the department (they see only this and the ticket number)'), desc,
    linkOut,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'secondary' }, 'Refer')));

    const info = h('div', { class: 'card' },
      h('p', {}, h('span', { class: 'chip' }, t.status), ' ', h('span', { class: `chip ${t.priority}` }, t.priority), ' ', slaChip(t),
        t.tracked ? '' : h('span', { class: 'chip' }, ' Untracked'), t.widespread ? h('span', { class: 'chip High' }, ' Widespread') : '',
        t.duplicate_of ? h('span', { class: 'chip' }, ` Possible duplicate of ${t.duplicate_of}`) : ''),
      h('p', { class: 'muted' }, `Created ${when(t.created_at)}${t.location ? ' · QR location: ' + t.location : ''}${t.reopen_count ? ' · reopened ' + t.reopen_count + '×' : ''}${t.rating ? ' · rating ' + t.rating + '/5' : ''}`),
      t.tracked
        ? h('p', {}, `Requester: ${t.requester_no || '(removed)'} · ${t.email || ''} · ${t.phone || ''}`)
        : h('p', { class: 'notice warn' }, `Untracked: requester declined consent. Reason: ${t.consent_reason || '—'}`),
      h('h3', {}, 'Issue'),
      h('p', { class: 'pre' }, t.issue),
      t.rating_comment ? h('p', { class: 'muted' }, `Feedback: ${t.rating_comment}`) : null,
      t.attachment ? h('p', {}, h('a', { href: `/api/tickets/${t.id}/attachment` }, `Download ${t.attachment.name} (${Math.ceil(t.attachment.size / 1024)} KB)`)) : null);

    const refs = t.referrals.length ? h('div', { class: 'card' }, h('h3', {}, 'Referrals'),
      h('ul', { class: 'events' }, t.referrals.map((r) => h('li', {},
        `${r.department} – ${r.surname}: ${r.description}`, h('br'),
        h('span', { class: 'muted' }, r.resolved_at ? `Resolved ${when(r.resolved_at)}${r.resolution_note ? ': ' + r.resolution_note : ''}` : `Open · link expires ${r.expires_ymd}`))))) : null;

    const history = h('div', { class: 'card' }, h('h3', {}, 'History'),
      h('ul', { class: 'events' }, t.events.map((ev) => h('li', { class: ev.type === 'note' && !ev.public ? 'internal' : '' },
        h('span', { class: 'muted' }, `${when(ev.at)} · ${ev.actor}`), h('br'),
        ev.type === 'status' ? `${ev.from_status || ''} → ${ev.to_status}` : '',
        ev.note ? (ev.type === 'status' ? ` – ${ev.note}` : ev.note) : '',
        ev.type === 'note' ? h('span', { class: 'chip' }, ev.public ? ' public' : ' internal') : null))));

    $('#dlg-body').replaceChildren(msg, info, update, refer, refs || '', history);
    if (!$('#dlg').open) $('#dlg').showModal();
  }

  // ---------- Referral links ----------
  async function loadLinks() {
    const rows = await call('/api/links');
    const act = (label, fn, cls = 'secondary small') => h('button', { type: 'button', class: cls, onclick: fn }, label);
    $('#l-body').replaceChildren(...rows.map((l) => {
      const state = l.revoked_at ? 'Revoked' : l.expires_at < Date.now() ? 'Expired' : l.failed_attempts >= 5 ? 'Locked' : 'Active';
      const run = async (p, ok) => { try { const r = await p; if (ok) alert(ok(r)); loadLinks(); } catch (e) { alert(e.message); } };
      return h('tr', {},
        h('td', {}, `${l.department} – ${l.surname}`, h('div', { class: 'muted' }, `by ${l.created_by || '?'} · ${when(l.created_at)}`)),
        h('td', {}, `${l.resolved || 0} / ${l.total} resolved`),
        h('td', {}, l.expires_ymd),
        h('td', {}, state),
        h('td', {}, l.revoked_at ? '' : h('div', { class: 'actions' },
          act('Resend', () => run(call(`/api/links/${l.id}/resend`, { method: 'POST' }), (r) => `New link emailed. Old link no longer works.\n${r.url}`)),
          act('Extend', () => {
            const days = prompt('Extend by how many working days? (1–10)', '2');
            if (!days) return;
            const reason = prompt('Reason for extending (required):');
            if (reason) run(call(`/api/links/${l.id}/extend`, { method: 'POST', body: { days: Number(days), reason } }), (r) => `Now expires at the end of ${r.expires}.`);
          }),
          act('Revoke', () => { if (confirm('Revoke this link? The recipient will no longer be able to open it.')) run(call(`/api/links/${l.id}/revoke`, { method: 'POST' })); }, 'danger small'))));
    }));
    if (!rows.length) $('#l-body').append(h('tr', {}, h('td', { colspan: 5 }, 'No referral links yet.')));
  }

  // ---------- Reports ----------
  const ymd = (ms) => new Date(ms + 7200000).toISOString().slice(0, 10);
  $('#r-from').value = ymd(Date.now() - 29 * 86400000);
  $('#r-to').value = ymd(Date.now());
  $('#r-form').addEventListener('submit', (e) => { e.preventDefault(); loadReports(); });
  $('#r-csv').addEventListener('click', () => { window.location.href = `/api/reports/export.csv?from=${$('#r-from').value}&to=${$('#r-to').value}`; });
  $('#r-print').addEventListener('click', () => window.print());
  function barTable(title, rows, extra = []) {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return h('div', { class: 'card table-wrap' }, h('h3', {}, title), h('table', {},
      h('tbody', {}, rows.map((r) => {
        const bar = h('div', { class: 'bar' });
        bar.style.width = `${(r.n / max) * 100}%`;
        return h('tr', {}, h('td', {}, r.k ?? r.day), h('td', {}, r.n), ...extra.map((x) => h('td', {}, x.fmt(r))), h('td', { class: 'no-print' }, bar));
      }))));
  }
  async function loadReports() {
    const r = await call(`/api/reports?from=${$('#r-from').value}&to=${$('#r-to').value}`);
    const s = r.summary;
    $('#r-out').replaceChildren(
      h('div', { class: 'card' }, h('h2', {}, `Report ${r.from} to ${r.to}`),
        h('p', {}, `Total ${s.total || 0} · Resolved ${s.resolved || 0} · Avg. resolution ${s.avg_hours ?? '–'} h · Avg. rating ${s.avg_rating ?? '–'} / 5 · Untracked ${s.untracked || 0}`)),
      h('div', { class: 'grid2' },
        barTable('Tickets per day', r.perDay),
        barTable('By category', r.byCategory),
        barTable('By status', r.byStatus),
        barTable('By QR location', r.byLocation),
        barTable('Department referrals', r.referrals, [{ fmt: (x) => `${x.resolved || 0} resolved` }]),
        barTable('By IT user', r.byStaff, [{ fmt: (x) => `${x.resolved || 0} resolved, avg ${x.avg_hours ?? '–'} h` }])));
  }

  // ---------- Users ----------
  async function loadUsers() {
    const rows = await call('/api/users');
    const act = (label, body, confirmText, cls = 'secondary small') => h('button', { type: 'button', class: cls, onclick: async () => {
      if (confirmText && !confirm(confirmText)) return;
      try { const r = await call(`/api/users/${body.id}`, { method: 'PATCH', body: body.patch }); if (r.password) alert(`Temporary password (shown once): ${r.password}`); loadUsers(); } catch (e) { alert(e.message); }
    } }, label);
    $('#u-body').replaceChildren(...rows.map((u) => h('tr', {},
      h('td', {}, u.username), h('td', {}, u.full_name, h('div', { class: 'muted' }, u.email)),
      h('td', {}, u.role === 'admin' ? 'SUDO admin' : 'IT user'), h('td', {}, u.role === 'admin' ? (u.has2fa ? 'On' : 'Not set up') : '—'),
      h('td', {}, u.active ? 'Active' : 'Disabled'),
      h('td', {}, u.id === cfg.user.id ? '(you)' : h('div', { class: 'actions' },
        act(u.active ? 'Disable' : 'Enable', { id: u.id, patch: { active: !u.active } }, u.active ? `Disable ${u.username}?` : null),
        act('Reset password', { id: u.id, patch: { resetPassword: true } }, `Reset the password for ${u.username}?`),
        u.role === 'admin' && u.has2fa ? act('Reset 2FA', { id: u.id, patch: { reset2fa: true } }, `Reset 2FA for ${u.username}?`) : null)))));
  }
  $('#u-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await call('/api/users', { method: 'POST', body: { staffId: $('#u-id').value, fullName: $('#u-name').value, email: $('#u-email').value, role: $('#u-role').value } });
      $('#u-msg').className = 'notice ok';
      $('#u-msg').textContent = `Created ${r.username}. Temporary password (shown once, give it to the user securely): ${r.password}`;
      $('#u-form').reset();
      loadUsers();
      cfg = await call('/api/me'); fillFilters();
    } catch (err) { $('#u-msg').className = 'error'; $('#u-msg').textContent = err.message; }
  });

  // ---------- Settings & knowledge base ----------
  const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
  async function loadSettings() {
    const s = await call('/api/settings');
    $('#set-remind').value = s.reminderWorkingDays;
    $('#set-escalate').value = s.escalationWorkingDays;
    $('#set-link').value = s.linkWorkingDays;
    $('#set-wide').value = s.widespreadThreshold;
    $('#set-retention').value = s.retentionDays;
    $('#set-sla').value = cfg.priorities.slice().reverse().map((p) => s.slaHours[p]).join(', ');
    $('#set-holidays').value = s.holidays.join('\n');
    $('#set-categories').value = s.categories.join('\n');
    $('#set-canned').value = s.cannedReplies.join('\n');
    $('#set-depts').value = s.departments.map((d) => `${d.code} | ${d.name} | ${d.email}${d.active ? '' : ' | off'}`).join('\n');
    loadKb();
  }
  $('#set-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sla = $('#set-sla').value.split(',').map((x) => Number(x.trim()));
    const body = {
      reminderWorkingDays: Number($('#set-remind').value), escalationWorkingDays: Number($('#set-escalate').value),
      linkWorkingDays: Number($('#set-link').value), widespreadThreshold: Number($('#set-wide').value),
      retentionDays: Number($('#set-retention').value),
      slaHours: { Urgent: sla[0], High: sla[1], Medium: sla[2], Low: sla[3] },
      holidays: lines($('#set-holidays').value), categories: lines($('#set-categories').value), cannedReplies: lines($('#set-canned').value),
      departments: lines($('#set-depts').value).map((l) => { const [code, name, email, off] = l.split('|').map((x) => (x || '').trim()); return { code, name, email, active: off !== 'off' }; }),
    };
    try {
      await call('/api/settings', { method: 'PUT', body });
      $('#set-msg').className = 'notice ok'; $('#set-msg').textContent = 'Settings saved.';
      cfg = await call('/api/me'); fillFilters();
    } catch (err) { $('#set-msg').className = 'error'; $('#set-msg').textContent = err.message; }
  });
  async function loadKb() {
    const rows = await call('/api/kb');
    $('#kb-list').replaceChildren(...rows.map((a) => h('div', { class: 'kb-item' }, h('strong', {}, a.title), ' ',
      h('button', { type: 'button', class: 'secondary small', onclick: () => { $('#kb-id').value = a.id; $('#kb-title').value = a.title; $('#kb-body').value = a.body; $('#kb-title').focus(); } }, 'Edit'), ' ',
      h('button', { type: 'button', class: 'danger small', onclick: async () => { if (confirm(`Delete “${a.title}”?`)) { await call(`/api/kb/${a.id}`, { method: 'DELETE' }); loadKb(); } } }, 'Delete'))));
  }
  $('#kb-clear').addEventListener('click', () => { $('#kb-form').reset(); $('#kb-id').value = ''; });
  $('#kb-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await call('/api/kb', { method: 'POST', body: { id: $('#kb-id').value || null, title: $('#kb-title').value, body: $('#kb-body').value } }); $('#kb-form').reset(); $('#kb-id').value = ''; loadKb(); }
    catch (err) { alert(err.message); }
  });

  // ---------- QR codes ----------
  $('#qr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const loc = $('#qr-loc').value.trim();
    const url = `${window.location.origin}/report.html${loc ? '?loc=' + encodeURIComponent(loc) : ''}`;
    $('#qr').replaceChildren();
    if (window.QRCode) new QRCode($('#qr'), { text: url, width: 256, height: 256 });
    else $('#qr').textContent = 'QR library could not load (offline?).';
    $('#qr-url').textContent = `${url}${loc ? ' · Location: ' + loc : ''}`;
  });
  $('#qr-print').addEventListener('click', () => window.print());

  // ---------- Audit ----------
  async function loadAudit() {
    const rows = await call('/api/audit');
    $('#a-body').replaceChildren(...rows.map((a) => h('tr', {}, h('td', {}, when(a.at)), h('td', {}, a.actor), h('td', {}, a.action), h('td', {}, a.details || ''), h('td', {}, a.ip || ''))));
  }

  // ---------- Notifications ----------
  async function loadNotifs() {
    if (!cfg) return;
    try {
      const n = await call('/api/notifications');
      $('#bell-count').textContent = n.unread;
      show('#bell-count', n.unread > 0);
      $('#bell').setAttribute('aria-label', `Alerts, ${n.unread} unread`);
      $('#notifs').replaceChildren(h('h2', {}, 'Alerts'), ...(n.items.length ? n.items.map((x) => h('div', { class: 'kb-item' },
        h('span', { class: 'muted' }, when(x.created_at)), x.read_at ? '' : h('span', { class: 'chip High' }, ' new'), h('br'),
        x.ticket_id ? h('button', { type: 'button', class: 'link', onclick: () => { show('#notifs', false); openTicket(x.ticket_id); } }, x.message) : x.message))
        : [h('p', { class: 'muted' }, 'No alerts.')]));
    } catch {}
  }
  $('#bell').addEventListener('click', async () => {
    const open = $('#notifs').classList.contains('hidden');
    show('#notifs', open);
    $('#bell').setAttribute('aria-expanded', String(open));
    if (open) { await call('/api/notifications/read', { method: 'POST' }).catch(() => {}); $('#bell-count').textContent = '0'; show('#bell-count', false); }
  });

  boot();
})();
