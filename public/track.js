'use strict';
(function () {
  let creds = null;
  for (let i = 1; i <= 5; i++) {
    $('#stars').append(h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'rating', value: i }), `${'★'.repeat(i)} ${i}`));
  }

  async function load() {
    const t = await api('/api/track', { method: 'POST', body: creds });
    $('#r-title').textContent = `Ticket ${t.number}`;
    $('#r-status').textContent = t.status;
    $('#r-meta').textContent = `${t.category} · opened ${when(t.createdAt)}${t.resolvedAt ? ' · resolved ' + when(t.resolvedAt) : ''}`;
    $('#r-events').replaceChildren(...t.events.map((e) => h('li', {}, h('span', { class: 'muted' }, when(e.at)), h('br'), e.text)));
    $('#rate').classList.toggle('hidden', !t.canRate);
    $('#reopen').classList.toggle('hidden', !t.canReopen);
    $('#result').classList.remove('hidden');
    $('#r-title').focus();
  }

  $('#find').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#find-err').textContent = '';
    creds = { number: $('#number').value.trim(), requesterNo: $('#requesterNo').value.trim() };
    if (!creds.number || !creds.requesterNo) { $('#find-err').textContent = 'Enter both the ticket number and your student/staff number.'; return; }
    try { await load(); } catch (err) { $('#result').classList.add('hidden'); $('#find-err').textContent = err.message; }
  });

  $('#rate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = $('input[name=rating]:checked');
    if (!r) { $('#rate-err').textContent = 'Choose 1 to 5 stars.'; return; }
    try {
      await api('/api/track/rate', { method: 'POST', body: { ...creds, rating: r.value, comment: $('#comment').value } });
      $('#rate').replaceWith(h('p', { class: 'notice ok' }, 'Thank you for your feedback.'));
    } catch (err) { $('#rate-err').textContent = err.message; }
  });

  $('#reopen').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/track/reopen', { method: 'POST', body: { ...creds, reason: $('#reopen-reason').value } });
      await load();
    } catch (err) { $('#reopen-err').textContent = err.message; }
  });
})();
