// ── Contact buttons + transient toast ───────────────────────────────
// The email button's address is split across data-u + data-d attributes
// in the HTML so the static source never contains `andre@acx.ci` as one
// string (defeats simple regex address scrapers) and no mailto: link
// for their spiders to follow. We stitch the address back together at
// load time to display it, and clicking the button copies it to the
// clipboard rather than launching a mail client.

// Shared toast singleton. Created on first use so the DOM stays clean
// when the page has no reason to show feedback. Reuses the same element
// across calls — the previous message is overwritten if another toast
// fires during the visible window.
let toastEl = null;
let toastTimer = null;
function ensureToast() {
  if (toastEl) return toastEl;
  toastEl = document.createElement('div');
  toastEl.className = 'toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);
  return toastEl;
}
export function showToast(message, { duration = 1800 } = {}) {
  const el = ensureToast();
  el.textContent = message;
  el.dataset.visible = 'true';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.dataset.visible = 'false';
    toastTimer = null;
  }, duration);
}

// Copy text via the modern async clipboard API, falling back to the
// legacy execCommand path for older browsers / non-secure contexts
// (GitHub Pages over HTTPS will always get the modern path).
async function copyToClipboard(text) {
  // Try the modern async clipboard API first — available on HTTPS and
  // on localhost, which covers both dev and prod. May reject if the
  // browser denies permission or the page lost user-activation.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('navigator.clipboard.writeText failed:', err);
    }
  }
  // Fallback: hidden textarea + document.execCommand('copy'). Still
  // works in contexts where the async API isn't available or denied.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (err) {
    console.warn('execCommand copy failed:', err);
    return false;
  }
}

export function setupContactButtons() {
  const emailBtn = document.getElementById('contact-email');
  if (!emailBtn) return;

  // Reassemble address from split attributes. Guarded so a missing
  // attribute doesn't render "undefined@undefined".
  const user    = emailBtn.dataset.u;
  const domain  = emailBtn.dataset.d;
  if (!user || !domain) return;
  const address = `${user}@${domain}`;

  // Paint the label now that we have the full address. The @ sign
  // gets its own wrapping span so CSS can give it extra breathing
  // room either side — at small sizes + wide letter-spacing the
  // symbol collides visually with the adjacent letters otherwise.
  const label = emailBtn.querySelector('.contact-label');
  if (label) {
    const atSpan = document.createElement('span');
    atSpan.className = 'at-sign';
    atSpan.textContent = '@';
    label.replaceChildren(
      document.createTextNode(user),
      atSpan,
      document.createTextNode(domain),
    );
  }

  // Stop only pointerdown from bubbling, so pressing the email button
  // during Fun Mode's `awaiting` state doesn't count as the gravity
  // press. Clicks are intentionally allowed to bubble — the window-
  // level click handler fires an accent pulse under the button, which
  // is the desired "every click on the page makes something happen"
  // behaviour.
  emailBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  emailBtn.addEventListener('click', async () => {
    try {
      const ok = await copyToClipboard(address);
      showToast(ok ? 'Email copied' : 'Copy failed — select the address to copy manually');
    } catch (err) {
      console.warn('Email copy failed:', err);
      showToast('Copy failed — select the address to copy manually');
    }
  });
}
