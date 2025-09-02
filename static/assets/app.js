/* ===========================
   AMC Spark — app.js (Heavy)
   =========================== */

/* ---------- Tiny helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/* Throttle & debounce */
const debounce = (fn, wait = 120) => {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
};
const throttle = (fn, limit = 120) => {
  let inThrottle = false, lastArgs;
  return function (...args) {
    lastArgs = args;
    if (!inThrottle) {
      inThrottle = true; fn.apply(this, lastArgs);
      setTimeout(() => { inThrottle = false; if (lastArgs !== args) fn.apply(this, lastArgs); }, limit);
    }
  };
};

/* Scroll lock (for mobile drawer) */
const ScrollLock = (() => {
  let locked = false, scrollY = 0;
  const lock = () => {
    if (locked) return;
    scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    locked = true;
  };
  const unlock = () => {
    if (!locked) return;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, scrollY);
    locked = false;
  };
  return { lock, unlock };
})();

/* Focus trap (basic) */
const createFocusTrap = (container) => {
  if (!container) return { enable: () => {}, disable: () => {} };
  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  let prevActive = null;
  function onKey(e) {
    if (e.key !== 'Tab') return;
    const nodes = $$(FOCUSABLE, container).filter(n => !n.hasAttribute('disabled') && !n.getAttribute('aria-hidden'));
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
  return {
    enable() { prevActive = document.activeElement; on(document, 'keydown', onKey); $$(FOCUSABLE, container)[0]?.focus(); },
    disable() { document.removeEventListener('keydown', onKey); prevActive?.focus?.(); }
  };
};

/* Smooth scroll (accounts for sticky header if present) */
function smoothScrollTo(id) {
  const target = document.getElementById(id);
  if (!target) return;
  const header = $('#site-header, .header');
  const offset = header ? clamp(header.offsetHeight, 0, 120) : 0;
  const y = target.getBoundingClientRect().top + window.scrollY - offset - 8;
  window.scrollTo({ top: y, behavior: 'smooth' });
}

/* Toast */
const Toast = (() => {
  let el;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:88px;z-index:9999;display:none';
    document.body.appendChild(el);
    return el;
  }
  return {
    show(msg = 'Done', ms = 1600) {
      const t = ensure();
      t.textContent = msg;
      t.style.display = 'block';
      clearTimeout(t._to);
      t._to = setTimeout(() => { t.style.display = 'none'; }, ms);
    }
  };
})();

/* Theme (persisted) */
(function themeInit(){
  const btn = $('#theme-toggle');
  const key = 'amc-theme';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const current = localStorage.getItem(key) || (prefersDark ? 'dark' : 'light');
  document.documentElement.dataset.theme = current;
  on(btn, 'click', () => {
    const next = (document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(key, next);
    Toast.show(next === 'dark' ? 'Dark mode 🌙' : 'Light mode ✨');
  });
})();

/* Sticky header shadow + back-to-top */
(function headerEffects(){
  const header = $('#site-header, .header');
  let backTop = $('#backTop');
  if (!backTop) {
    backTop = document.createElement('a');
    backTop.id = 'backTop';
    backTop.href = '#home';
    backTop.textContent = '↑';
    backTop.setAttribute('aria-label','Back to top');
    backTop.style.display = 'none';
    document.body.appendChild(backTop);
  }
  const onScroll = throttle(() => {
    const sc = window.scrollY;
    if (header) header.classList.toggle('is-scrolled', sc > 8);
    backTop.style.display = sc > 600 ? 'inline-flex' : 'none';
  }, 100);
  on(window, 'scroll', onScroll);
  on(backTop, 'click', (e) => {
    e.preventDefault();
    smoothScrollTo('home');
  });
  onScroll();
})();

/* Mobile nav: open/close + focus trap + ESC + outside click */
(function mobileNav(){
  const toggle = $('#mobileToggle, #nav-toggle');
  const nav = $('#mainNav, #site-nav');
  if (!toggle || !nav) return;

  const trap = createFocusTrap(nav);
  const open = () => {
    nav.classList.add('open');
    toggle.setAttribute('aria-expanded','true');
    ScrollLock.lock();
    trap.enable();
  };
  const close = () => {
    nav.classList.remove('open');
    toggle.setAttribute('aria-expanded','false');
    ScrollLock.unlock();
    trap.disable();
  };

  on(toggle, 'click', () => nav.classList.contains('open') ? close() : open());
  on(document, 'keydown', (e) => (e.key === 'Escape' && nav.classList.contains('open')) && close());

  on(document, 'click', (e) => {
    if (!nav.classList.contains('open')) return;
    const within = nav.contains(e.target) || toggle.contains(e.target);
    if (!within) close();
  });

  // Close on link click
  $$('#mainNav a, #site-nav a').forEach(a => on(a, 'click', close));
})();

/* Smooth-scroll for internal anchors */
(function smoothAnchors(){
  $$('a[href^="#"]').forEach(a => {
    on(a, 'click', (e) => {
      const id = a.getAttribute('href').slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      smoothScrollTo(id);
    });
  });
})();

/* Active section highlighting (IO-based) */
(function activeNav(){
  const links = $$('#mainNav a, #site-nav a');
  if (!links.length) return;
  const idFromHref = (href) => href.startsWith('#') ? href.slice(1) : href.split('#')[1];
  const map = new Map();
  links.forEach(l => {
    const id = idFromHref(l.getAttribute('href') || '') || '';
    const el = id && document.getElementById(id);
    if (el) map.set(el, l);
  });
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const link = map.get(entry.target);
      if (!link) return;
      if (entry.isIntersecting) {
        links.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px', threshold: [0, 0.3, 1] });
  map.forEach((_, el) => io.observe(el));
})();

/* In-view animations hook (adds .in-view) */
(function inView(){
  const targets = $$('[data-io], .card, .gitem, .stats li');
  if (!targets.length) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting){ e.target.classList.add('in-view'); io.unobserve(e.target);} });
  }, { threshold: 0.2 });
  targets.forEach(t => io.observe(t));
})();

/* Forms: tabs + fetch submit + status + basic client-side checks */
(function forms(){
  const tabs = $$('.form-tabs .tab');
  const panes = $$('.tabpanes .pane');
  if (tabs.length && panes.length) {
    function activate(idx){
      tabs.forEach((t,i)=>{ t.classList.toggle('is-active', i===idx); t.setAttribute('aria-selected', i===idx ? 'true':'false'); });
      panes.forEach((p,i)=>{ p.classList.toggle('is-active', i===idx); p.hidden = i !== idx; });
    }
    tabs.forEach((t,i)=> on(t,'click',()=>activate(i)));
    // Deep link: #forms or #pane-contact etc.
    if (location.hash) {
      const targetPane = panes.find(p => `#${p.id}` === location.hash);
      const idx = targetPane ? panes.indexOf(targetPane) : 0;
      activate(idx);
    } else activate(0);
  }

  async function handleSubmit(formSel, url, statusSel){
    const form = $(formSel); if (!form) return;
    const status = $(statusSel);
    on(form, 'submit', async (e) => {
      e.preventDefault();
      status && (status.textContent = 'Sending…');
      try{
        const fd = new FormData(form);
        const resp = await fetch(url, { method: 'POST', body: fd });
        if (!resp.ok) throw new Error(`Network ${resp.status}`);
        status && (status.textContent = 'Done. We’ll reach out soon ✅');
        Toast.show('Sent!');
        form.reset();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }catch(err){
        status && (status.textContent = 'Failed. Try again.');
        Toast.show('Something went wrong ❌');
      }
    });
  }
  // Only attaches if these forms exist in your HTML
  handleSubmit('#qqForm', '/api/quote',  '#qqStatus');
  handleSubmit('#contactForm', '/api/contact', '#contactStatus');
  handleSubmit('#projForm', '/api/project', '#projStatus');

  // File input count label
  $$('input[type="file"]').forEach(inp => {
    on(inp, 'change', () => {
      const c = inp.files?.length || 0;
      inp.title = c ? `${c} file(s) selected` : 'No file chosen';
    });
  });
})();

/* Lazy-enhance images: add decoding=async and handle errors */
(function images(){
  $$('img').forEach(img => {
    img.decoding = 'async';
    on(img, 'error', () => { img.alt = img.alt || 'Image failed to load'; });
  });
})();

/* Footer year */
(function year(){
  const y = $('#year, footer .year');
  if (y) y.textContent = new Date().getFullYear();
})();

/* Keyboard accessibility: space/enter on buttons with role/link-like usage */
(function kbd(){
  $$('button[role="link"]').forEach(btn => {
    on(btn, 'keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); btn.click(); }
    });
  });
})();
