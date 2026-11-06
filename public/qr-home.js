'use strict';
// Start page: shows a QR code that opens the issue form (report.html) on the user's phone.
// A ?loc= tag on this page (e.g. /?loc=Library) is carried into the QR code, so tickets show where it was scanned.
(function () {
  const loc = new URLSearchParams(window.location.search).get('loc') || '';
  const target = `${window.location.origin}/report.html${loc ? '?loc=' + encodeURIComponent(loc) : ''}`;

  $('#report-link').href = target;
  $('#qr-url').textContent = target;
  if (loc) $('#qr-location').textContent = `Location: ${loc}`;

  if (window.QRCode) {
    new QRCode($('#qr'), { text: target, width: 260, height: 260, correctLevel: QRCode.CorrectLevel.M });
  } else {
    // QR library could not load (offline): the address below and the button still work.
    $('#qr').replaceChildren(h('p', { class: 'notice warn' }, 'The QR code could not load. Open the address below or tap the button.'));
  }

  $('#print').addEventListener('click', () => window.print());
})();
