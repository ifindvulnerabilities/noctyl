// The Noctyl server's sign-in page: sign in, create an account (when the server allows it), reset a password with a
// recovery code, choose a password for an account an admin made, and show a new recovery code once.
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  // iPhone Safari ignores "no zoom" in the viewport tag: cancel its pinch gesture here
  for (const g of ['gesturestart', 'gesturechange']) document.addEventListener(g, e => e.preventDefault(), { passive: false });
  const views = ['signin', 'signup', 'recover', 'password', 'recovery'];
  const show = id => { views.forEach(v => { $('#' + v).hidden = v !== id; }); $(`#${id} input:not([type=checkbox])`)?.focus(); };
  const api = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Noctyl': '1' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Something went wrong (${r.status})`);
    return j;
  };
  // after signing in: back to where you were going (a shared conversation's link), or the chat. Only a path on this
  // site is accepted, so a crafted link can't send you anywhere else.
  const next = new URLSearchParams(location.search).get('next') || '';
  const enter = () => location.replace(/^\/share\/[0-9a-f-]{36}\/?$/i.test(next) || /^\/chat\/[\w-]{1,80}\/?$/.test(next) ? next : '/');
  /** a form: run fn with its values, show any error under it, keep the button disabled while it works */
  const handle = (id, fn) => {
    const form = $('#' + id), err = form.querySelector('.err'), btn = form.querySelector('button[type=submit]');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.textContent = '';
      const v = Object.fromEntries(new FormData(form));
      if ('password2' in v && v.password !== v.password2) { err.textContent = "The two passwords don't match."; return; }
      btn.disabled = true;
      try { await fn(v); } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
    });
  };
  let after = enter;
  const showRecovery = (code, then = enter) => {
    after = then;
    $('#code').textContent = code;
    $('#saved').checked = false;
    $('#continue').disabled = true;
    show('recovery');
  };

  handle('signin', async v => { const r = await api('/api/login', { name: v.name, password: v.password }); r.mustChangePassword ? show('password') : enter(); });
  handle('signup', async v => { const r = await api('/api/register', { name: v.name, password: v.password, setupCode: v.setupCode }); showRecovery(r.recovery); });
  handle('recover', async v => { const r = await api('/api/recover', { name: v.name, code: v.code, password: v.password }); showRecovery(r.recovery); });
  handle('password', async v => { const r = await api('/api/password', { password: v.password }); r.recovery ? showRecovery(r.recovery) : enter(); });

  document.addEventListener('click', e => { const go = e.target.closest('[data-go]'); if (go) show(go.dataset.go); });
  $('#saved').addEventListener('change', e => { $('#continue').disabled = !e.target.checked; });
  $('#continue').addEventListener('click', () => after());
  $('#copy').addEventListener('click', async () => {
    // the clipboard API needs https (or localhost); over plain http the older copy command works from a click
    const text = $('#code').textContent;
    const legacy = () => { const sel = getSelection(); sel.selectAllChildren($('#code')); const ok = document.execCommand('copy'); sel.removeAllRanges(); if (!ok) throw new Error('copy'); };
    try {
      if (window.isSecureContext && navigator.clipboard) await navigator.clipboard.writeText(text).catch(legacy); else legacy();
      $('#copy').textContent = 'Copied'; setTimeout(() => { $('#copy').textContent = 'Copy'; }, 1500);
    }
    catch { getSelection().selectAllChildren($('#code')); }
  });
  $('#download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Noctyl recovery code for ${location.host}\n\n${$('#code').textContent}\n\nKeep it somewhere safe. It resets your password if you forget it.\n`], { type: 'text/plain' }));
    a.download = 'noctyl-recovery-code.txt';
    a.click();
  });

  fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json()).then(s => {
    if (s.user && location.hash === '#password' && s.user.mustChangePassword) return show('password');
    if (s.user && !s.user.mustChangePassword) return enter();
    $('#signupLine').hidden = !s.signUp;   // "Don't have an account? Sign up." only when the server allows it
    $('#signupNote').hidden = s.signUp || !s.signUpNote;
    $('#signupNote').textContent = s.signUpNote || '';
    if (s.setup) {
      $('#signupTitle').textContent = 'Set up Noctyl';
      $('#setupLead').hidden = false;
      $('#setupField').hidden = false;
      $('#setupField input').required = true;
      $('#signupBack').hidden = true;
      return show('signup');
    }
    show('signin');
  }).catch(() => show('signin'));
})();
