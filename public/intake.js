// Public intake: Details -> Issue -> Ticket. The draft is kept in sessionStorage so
// going back or refreshing never loses what was typed (it is cleared once the ticket exists).
'use strict';
(function () {
  const RX = {
    requesterNo: /^[A-Za-z0-9\/-]{3,20}$/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    phone: /^\+[1-9]\d{7,14}$/,
  };
  const MSG = {
    requesterNo: 'Enter your student or staff number (3–20 letters, digits, / or -).',
    email: 'Enter a valid email address, e.g. name@example.com.',
    phone: 'Use international format, e.g. +260971234567.',
  };
  const location = new URLSearchParams(window.location.search).get('loc') || '';
  const KEY = 'helpdesk-draft';
  let draft = {};
  try { draft = JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch {}
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(draft)); } catch {} };

  const f1 = $('#step1'), f2 = $('#step2');
  const fields = ['requesterNo', 'email', 'phone'];
  const normPhone = (v) => v.replace(/[\s()-]/g, '');
  const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  const sentences = (s) => s.split(/[.!?]+/).filter((x) => x.trim()).length;

  function setErr(id, msg) {
    $(`#${id}-err`).textContent = msg || '';
    const input = $(`#${id}`);
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  function fieldOk(id, show) {
    const v = id === 'phone' ? normPhone($(`#${id}`).value) : $(`#${id}`).value.trim();
    const ok = RX[id].test(v);
    if (show) setErr(id, ok ? '' : MSG[id]);
    return ok;
  }
  function consentValue() { const c = $('input[name=consent]:checked'); return c ? c.value : null; }
  function reasonOk(show) {
    const r = $('#reason').value.trim();
    let msg = '';
    if (!r) msg = 'Please give a reason.';
    else if (sentences(r) > 3) msg = 'Please keep it to 1–3 sentences.';
    if (show) setErr('reason', msg);
    return !msg;
  }
  function step1Ok() {
    const c = consentValue();
    return fields.every((id) => fieldOk(id, false)) && (c === 'yes' || (c === 'no' && reasonOk(false)));
  }
  function refresh1() {
    const c = consentValue();
    $('#reason-box').classList.toggle('hidden', c !== 'no');
    $('#reason-count').textContent = `${$('#reason').value.length} / 300 characters (1–3 sentences)`;
    $('#proceed1').disabled = !step1Ok();
  }
  // Security check: Cloudflare Turnstile when the server has keys, otherwise an arithmetic question.
  let turnstile = null; // { widgetId, token }
  const captchaDone = () => (turnstile ? !!turnstile.token : !!$('#captcha').value.trim());
  function refresh2() {
    const v = $('#issue').value;
    $('#issue-count').textContent = `${words(v)} word${words(v) === 1 ? '' : 's'}`;
    $('#proceed2').disabled = !v.trim() || !captchaDone();
  }

  function showStep(n) {
    [f1, f2, $('#step3')].forEach((el, i) => el.classList.toggle('hidden', i !== n - 1));
    $$('ol.steps li').forEach((li) => {
      const s = Number(li.dataset.step);
      if (s === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      li.classList.toggle('done', s < n);
    });
    $(`#step${n} h2`).focus();
    draft.step = n < 3 ? n : 1;
    save();
  }

  // Restore draft
  for (const id of [...fields, 'reason', 'issue']) if (draft[id]) $(`#${id}`).value = draft[id];
  if (draft.consent) $(`input[name=consent][value=${draft.consent}]`).checked = true;

  // Step 1 events
  f1.addEventListener('input', (e) => {
    if (e.target.name === 'consent') draft.consent = e.target.value;
    else if (e.target.id) draft[e.target.id] = e.target.value;
    if (fields.includes(e.target.id) && $(`#${e.target.id}-err`).textContent) fieldOk(e.target.id, true);
    if (e.target.id === 'reason') reasonOk(true);
    save();
    refresh1();
  });
  fields.forEach((id) => $(`#${id}`).addEventListener('blur', () => $(`#${id}`).value && fieldOk(id, true)));
  f1.addEventListener('submit', (e) => {
    e.preventDefault();
    const bad = fields.filter((id) => !fieldOk(id, true));
    if (bad.length) return $(`#${bad[0]}`).focus();
    if (consentValue() === 'no' && !reasonOk(true)) return $('#reason').focus();
    if (step1Ok()) showStep(2);
  });

  // Step 2 events
  f2.addEventListener('input', (e) => {
    if (e.target.id === 'issue' || e.target.id === 'category') { draft[e.target.id] = e.target.value; save(); }
    if (e.target.id === 'issue' && e.target.value.trim()) setErr('issue', '');
    refresh2();
  });
  $('#back2').addEventListener('click', () => showStep(1));
  $('#file').addEventListener('change', () => {
    const file = $('#file').files[0];
    let msg = '';
    if (file && !['image/png', 'image/jpeg', 'application/pdf'].includes(file.type)) msg = 'Only PNG, JPG or PDF files are allowed.';
    else if (file && file.size > 2 * 1024 * 1024) msg = 'The file must be 2 MB or smaller.';
    setErr('file', msg);
    if (msg) $('#file').value = '';
  });

  async function loadCaptcha() {
    if (turnstile) {
      turnstile.token = '';
      if (window.turnstile && turnstile.widgetId != null) window.turnstile.reset(turnstile.widgetId);
      return refresh2();
    }
    try {
      const c = await api('/api/captcha');
      $('#captcha-q').textContent = c.question;
      $('#captcha').dataset.token = c.token;
    } catch (e) { $('#captcha-q').textContent = e.message; }
  }
  function startTurnstile(siteKey) {
    turnstile = { widgetId: null, token: '' };
    $('#turnstile-box').classList.remove('hidden');
    window.onTurnstileLoad = () => {
      turnstile.widgetId = window.turnstile.render('#turnstile', {
        sitekey: siteKey,
        callback: (token) => { turnstile.token = token; setErr('captcha', ''); refresh2(); },
        'expired-callback': () => { turnstile.token = ''; refresh2(); },
        'error-callback': () => { turnstile.token = ''; setErr('captcha', 'The security check could not load. Check your connection and refresh the page.'); refresh2(); },
      });
    };
    document.head.append(h('script', { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad', async: true }));
  }
  const readFile = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  f2.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('#issue').value.trim()) { setErr('issue', 'Please describe your issue.'); return $('#issue').focus(); }
    const btn = $('#proceed2');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    setErr('submit', '');
    setErr('captcha', '');
    try {
      const file = $('#file').files[0];
      const body = {
        requesterNo: $('#requesterNo').value, email: $('#email').value, phone: $('#phone').value,
        consent: consentValue(), reason: $('#reason').value, category: $('#category').value,
        issue: $('#issue').value, location, website: $('#website').value,
        captchaToken: $('#captcha').dataset.token, captchaAnswer: $('#captcha').value,
        turnstileToken: turnstile ? turnstile.token : undefined,
        attachment: file ? { name: file.name, mime: file.type, data: await readFile(file) } : null,
      };
      const res = await api('/api/tickets', { method: 'POST', body });
      $('#ticket-no').textContent = `Ticket ${res.number}`;
      $('#ticket-msg').textContent = res.tracked
        ? 'Keep this number. We have also sent it to your email and WhatsApp. You can track progress with the ticket number and your student/staff number.'
        : 'This ticket is Untracked: we will not contact you and it cannot be tracked online. Please write down the number if you call the IT office.';
      $('#track-link').classList.toggle('hidden', !res.tracked);
      try { sessionStorage.removeItem(KEY); } catch {}
      draft = {};
      showStep(3);
    } catch (err) {
      const field = err.data && err.data.field;
      if (field === 'captcha') { setErr('captcha', err.message); loadCaptcha(); $('#captcha').value = ''; $('#captcha').focus(); }
      else if (['requesterNo', 'email', 'phone', 'consent', 'reason'].includes(field)) { showStep(1); if ($(`#${field}-err`)) setErr(field, err.message); }
      else setErr(field === 'issue' || field === 'attachment' ? (field === 'issue' ? 'issue' : 'file') : 'submit', err.message);
      if (err.status !== 400 || turnstile) loadCaptcha(); // Turnstile tokens work only once
    } finally {
      btn.textContent = 'PROCEED';
      refresh2();
    }
  });

  $('#new-ticket').addEventListener('click', () => window.location.reload());

  // Knowledge base search (debounced)
  let kbTimer;
  async function kbSearch() {
    const out = $('#kb-results');
    try {
      const rows = await api(`/api/kb?q=${encodeURIComponent($('#kb-q').value.trim())}`);
      out.replaceChildren(...(rows.length ? rows.map((a) => h('div', { class: 'kb-item' }, h('strong', {}, a.title), h('p', {}, a.body)))
        : [h('p', { class: 'muted' }, 'No matching articles. Please submit a ticket below.')]));
    } catch (e) { out.replaceChildren(h('p', { class: 'error' }, e.message)); }
  }
  $('#kb-q').addEventListener('input', () => { clearTimeout(kbTimer); kbTimer = setTimeout(kbSearch, 300); });
  $('#kb').addEventListener('toggle', () => { if ($('#kb').open && !$('#kb-results').childElementCount) kbSearch(); });

  // Init
  api('/api/public-config').then((c) => {
    for (const cat of c.categories) $('#category').append(h('option', { value: cat }, cat));
    if (draft.category) $('#category').value = draft.category;
    $('#file-box').classList.toggle('hidden', !c.uploads);
    if (c.turnstileSiteKey) startTurnstile(c.turnstileSiteKey);
    else { $('#math-box').classList.remove('hidden'); loadCaptcha(); }
  }).catch((e) => setErr('submit', e.message));
  refresh1();
  refresh2();
  if (draft.step === 2 && step1Ok()) showStep(2);
})();
