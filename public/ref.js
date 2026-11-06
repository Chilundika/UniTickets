'use strict';
// Temporal user page. The token is read from the #fragment (never sent in URLs to the server)
// and kept only in memory; every request re-sends token + department + surname.
(function () {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
  history.replaceState(null, '', window.location.pathname); // remove the token from the address bar
  let creds = null;

  if (!token) {
    $('#confirm').replaceChildren(h('h2', {}, 'Link not valid'), h('p', {}, 'Please open the full link from your email, or ask the IT Helpdesk to resend it.'));
    return;
  }

  function render(d) {
    $('#who').textContent = `${d.department} – ${d.surname} (Temporal user)`;
    $('#expiry').textContent = `This link expires at the end of ${d.expires}. Please do not forward it.`;
    $('#items').replaceChildren(...d.items.map((it) => {
      const card = h('article', { class: 'card' },
        h('h3', {}, `Ticket ${it.number}`),
        h('p', { class: 'muted' }, `Referred ${when(it.created_at)}`),
        h('p', {}, it.description));
      if (it.resolved_at) {
        card.append(h('p', { class: 'notice ok' }, `Resolved ${when(it.resolved_at)}${it.resolution_note ? ': ' + it.resolution_note : ''}`));
      } else {
        const id = `note-${it.id}`;
        const err = h('p', { class: 'error', 'aria-live': 'polite' });
        const note = h('textarea', { id, maxlength: 500, class: 'short-ta' });
        const btn = h('button', {
          type: 'button',
          onclick: async () => {
            btn.disabled = true;
            try {
              await api('/api/ref/resolve', { method: 'POST', body: { ...creds, referralId: it.id, note: note.value } });
              render(await api('/api/ref/open', { method: 'POST', body: creds }));
            } catch (e) { err.textContent = e.message; btn.disabled = false; }
          },
        }, 'Issue Resolved');
        card.append(h('label', { for: id }, 'Resolution note (optional)'), note, err, h('div', { class: 'actions end' }, btn));
      }
      return card;
    }));
    if (!d.items.length) $('#items').append(h('p', { class: 'card' }, 'No issues on this link.'));
  }

  $('#confirm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#confirm-err').textContent = '';
    creds = { token, department: $('#department').value.trim(), surname: $('#surname').value.trim() };
    try {
      render(await api('/api/ref/open', { method: 'POST', body: creds }));
      $('#confirm').classList.add('hidden');
      $('#list').classList.remove('hidden');
      $('#who').focus();
    } catch (err) { $('#confirm-err').textContent = err.message; }
  });
})();
