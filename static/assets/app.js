// ---------- Tiny helpers ----------
const qs  = (s, r=document)=>r.querySelector(s);
const qsa = (s, r=document)=>Array.from(r.querySelectorAll(s));

// ---------- Mobile nav ----------
qs('#mobileBtn')?.addEventListener('click', () => {
  qs('#navlinks')?.classList.toggle('open');
});

// ---------- Active section highlight ----------
const sectionIds = ['services','supply','projects','downloads','forms','contact'];
const sections = sectionIds.map(id => qs('#'+id)).filter(Boolean);
const links = qsa('.navlinks a');
if (sections.length && links.length){
  const spy = new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      const id = entry.target.id;
      links.forEach(l => {
        if (l.getAttribute('href') === '#'+id) {
          l.classList.toggle('active', entry.isIntersecting);
        }
      });
    });
  },{rootMargin:'-40% 0px -50% 0px', threshold:0.01});
  sections.forEach(s=>spy.observe(s));
}

// ---------- Reveal on scroll ----------
const revealObs = new IntersectionObserver((ents)=>{
  ents.forEach(e=>{
    if(e.isIntersecting){
      e.target.style.opacity='1';
      e.target.style.transform='translateY(0)';
      revealObs.unobserve(e.target);
    }
  });
},{threshold:.15});
qsa('.reveal').forEach(el=>revealObs.observe(el));

// ---------- Scrollbar + back-to-top ----------
const bar = qs('#scrollbar');
const backTop = qs('#backTop');
const hero = qs('.hero');
if (hero && backTop){
  const btObs = new IntersectionObserver(([e])=>{
    backTop.classList.toggle('show', !e.isIntersecting);
  }, {threshold:0.01});
  btObs.observe(hero);
}
if (bar){
  window.addEventListener('scroll', ()=>{
    const h = document.documentElement;
    const p = (h.scrollTop)/(h.scrollHeight - h.clientHeight);
    bar.style.width = (p*100).toFixed(2) + '%';
  }, {passive:true});
}

// ---------- Theme toggle (persist) ----------
const themeBtn = qs('#themeBtn');
const setTheme = (m)=>{ document.documentElement.dataset.theme = m; localStorage.setItem('theme', m); };
setTheme(localStorage.getItem('theme') || 'light');
themeBtn?.addEventListener('click', ()=>{
  const cur = document.documentElement.dataset.theme || 'light';
  setTheme(cur === 'dark' ? 'light' : 'dark');
});

// ---------- Toast helper ----------
const toast = (msg)=>{
  const t = qs('#toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 1800);
};

// ---------- Brand Tagline Popup (auto-show on load) ----------
const brandModal = qs('#brandModal');
const brandClose = qs('#brandClose');
if (brandModal){
  window.addEventListener('load', ()=>{
    brandModal.hidden = false;
    brandModal.classList.add('show'); // CSS .modal.show { display:grid }
  });
  brandClose?.addEventListener('click', ()=>{
    brandModal.classList.remove('show');
    brandModal.hidden = true;
  });
  brandModal.addEventListener('click', (e)=>{
    if (e.target === brandModal){
      brandClose?.click();
    }
  });
}

// ---------- Optional: Carousel (only if present) ----------
const track = qs('#projectTrack');
const slides = track ? Array.from(track.children) : [];
let idx = 0;
const move = (i)=>{
  if(!slides.length) return;
  idx=(i+slides.length)%slides.length;
  track.style.transform = `translateX(-${idx*100}%)`;
};
qs('#prevSlide')?.addEventListener('click', ()=>move(idx-1));
qs('#nextSlide')?.addEventListener('click', ()=>move(idx+1));
if (slides.length) setInterval(()=>move(idx+1), 7000);
document.addEventListener('keydown', e=>{
  if (slides.length){
    if (e.key==='ArrowLeft') move(idx-1);
    if (e.key==='ArrowRight') move(idx+1);
  }
});

// ---------- Optional: Gallery filters (only if chips exist) ----------
const chips = qsa('.chip');
const gallery = qs('#gallery');
if (chips.length && gallery){
  chips.forEach(ch=>{
    ch.addEventListener('click', ()=>{
      chips.forEach(c=>c.classList.remove('active'));
      ch.classList.add('active');
      const f = ch.dataset.filter;
      qsa('.gitem', gallery).forEach(el=>{
        el.style.display = (f==='all' || el.dataset.cat===f) ? '' : 'none';
      });
    });
  });
}

// ---------- Footer year ----------
qs('#year') && (qs('#year').textContent = new Date().getFullYear());

// ---------- Loader + tiny beep ----------
const loader = qs('#loaderFS');
let audioCtx;
function beep(type='success'){
  try{
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    const now = audioCtx.currentTime;
    if(type==='success'){ o.frequency.setValueAtTime(880, now); o.frequency.exponentialRampToValueAtTime(1320, now+0.15); }
    else{ o.frequency.setValueAtTime(220, now); o.frequency.exponentialRampToValueAtTime(160, now+0.25); }
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.2, now+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now+0.3);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(now+0.32);
  }catch{}
}
function showLoader(msg='Sending… good vibes only ✨'){
  if(!loader) return;
  const label = loader.querySelector('.loader-txt');
  if(label) label.textContent = msg;
  loader.classList.add('show');
  loader.setAttribute('aria-hidden','false');
}
function hideLoader(){
  if(!loader) return;
  loader.classList.remove('show');
  loader.setAttribute('aria-hidden','true');
}

// ---------- Forms: validators & POST helpers ----------
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const validPhone = v => /^[+\d][\d\s\-()]{7,}$/.test(v);

async function postJSON(url, data){
  const r = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(data)
  });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json().catch(()=>({ok:true}));
}

async function postForm(url, formData){
  const r = await fetch(url, { method:'POST', body: formData });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json().catch(()=>({ok:true}));
}

// ---------- 3-Button Form Toggle ----------
const tabBtns = ['btn-qq','btn-contact','btn-project'].map(id=>qs('#'+id)).filter(Boolean);
const panesMap = {
  'btn-qq': qs('#pane-qq'),
  'btn-contact': qs('#pane-contact'),
  'btn-project': qs('#pane-project')
};
function activateFormTab(btn){
  if(!btn) return;
  tabBtns.forEach(b=>{
    b.classList.toggle('active', b===btn);
    b.setAttribute('aria-selected', String(b===btn));
  });
  Object.values(panesMap).forEach(p=> p && (p.hidden = true, p.classList.remove('active')));
  const pane = panesMap[btn.id];
  if(pane){ pane.hidden = false; pane.classList.add('active'); (pane.querySelector('input,select,textarea,button')||pane).focus(); }
}
tabBtns.forEach(b=> b.addEventListener('click', ()=> activateFormTab(b)));
// default active is Quick Quote (as per HTML)
activateFormTab(qs('#btn-qq'));

// ---------- Quick Quote (pane) ----------
const qqForm = qs('#qqForm');
const qqStatus = qs('#qqStatus');
qqForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = qs('#qqName')?.value.trim();
  const email = qs('#qqEmail')?.value.trim();
  const phone = qs('#qqPhone')?.value.trim();
  const ptype = qs('#qqType')?.value;
  const when = qs('#qqWhen')?.value;
  const notes = qs('#qqNotes')?.value;

  if(!name || !validEmail(email) || !validPhone(phone) || !ptype){
    if(qqStatus){ qqStatus.textContent='Please complete required fields.'; qqStatus.style.color='var(--danger)'; }
    return;
  }
  if(qqStatus){ qqStatus.textContent='Sending…'; qqStatus.style.color='inherit'; }
  showLoader('Locking in your quote…');
  try{
    const res = await postJSON('/api/quote', {name, email, phone, ptype, when, notes});
    if(qqStatus){ qqStatus.textContent = res?.ok ? 'Thanks! We’ll reply within 24 hours. ✅' : 'Submitted ✅'; qqStatus.style.color='var(--ok)'; }
    qqForm.reset(); beep('success'); toast('Quote request sent!');
  }catch(err){
    if(qqStatus){ qqStatus.textContent='Could not send now. Please email info@amcspark.com'; qqStatus.style.color='var(--danger)'; }
    toast('Opening mail client…'); window.location.href='mailto:info@amcspark.com'; beep('fail');
  }finally{ hideLoader(); }
});

// ---------- Contact form ----------
const contactForm = qs('#contactForm');
const contactStatus = qs('#contactStatus');
contactForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = qs('#cname')?.value.trim();
  const email = qs('#cemail')?.value.trim();
  const message = qs('#cmsg')?.value.trim();

  if(!name || !validEmail(email) || !message){
    if(contactStatus){ contactStatus.textContent='Please fill all required fields (valid email).'; contactStatus.style.color='var(--danger)'; }
    return;
  }
  if(contactStatus){ contactStatus.textContent='Sending…'; contactStatus.style.color='inherit'; }
  showLoader('Sending your message…');
  try{
    const res = await postJSON('/api/contact', {name, email, message});
    if(contactStatus){ contactStatus.textContent = res?.ok ? 'Message sent ✅' : 'Sent ✅'; contactStatus.style.color = 'var(--ok)'; }
    contactForm.reset(); beep('success'); toast('Message sent!');
  }catch(err){
    if(contactStatus){ contactStatus.textContent = 'Could not send right now. Try email: info@amcspark.com'; contactStatus.style.color='var(--danger)'; }
    toast('Opening mail client…'); window.location.href='mailto:info@amcspark.com'; beep('fail');
  }finally{ hideLoader(); }
});

// ---------- Project Desk form (with autosave) ----------
const projForm = qs('#projForm');
const projStatus = qs('#projStatus');

function saveAuto(){
  const ids=['org','name','email','phone','location','ptype','mode','voltage','podate','notes'];
  const d={}; ids.forEach(id=>{ const el=qs('#'+id); if(el) d[id]=el.value; });
  localStorage.setItem('projAuto', JSON.stringify(d));
}
function loadAuto(){
  try{
    const d=JSON.parse(localStorage.getItem('projAuto')||'{}');
    Object.entries(d).forEach(([k,v])=>{ const el=qs('#'+k); if(el && v!=null) el.value=v; });
  }catch{}
}
loadAuto();
['org','name','email','phone','location','ptype','mode','voltage','podate','notes']
  .forEach(id=> qs('#'+id)?.addEventListener('input', saveAuto));

projForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const emailEl = qs('#email');
  const phoneEl = qs('#phone');
  const email = emailEl?.value.trim() || '';
  const phone = phoneEl?.value.trim() || '';
  if(!projForm.checkValidity() || !validEmail(email) || !validPhone(phone)){
    if(projStatus){ projStatus.textContent = 'Please complete required fields with valid details.'; projStatus.style.color = 'var(--danger)'; }
    return;
  }
  if(projStatus){ projStatus.textContent = 'Submitting…'; projStatus.style.color='inherit'; }
  showLoader('Uploading files & creating ticket…');

  const fd = new FormData(projForm);
  const summary = {
    org: fd.get('org'), name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'),
    location: fd.get('location'), ptype: fd.get('ptype'), mode: fd.get('mode'),
    voltage: fd.get('voltage'), podate: fd.get('podate'), notes: fd.get('notes')
  };
  fd.append('_summary', JSON.stringify(summary));

  try{
    const res = await postForm('/api/project', fd);
    if(projStatus){ projStatus.textContent = res?.ok ? 'Received. We will respond within 24 hours. ✅' : 'Submitted ✅'; projStatus.style.color='var(--ok)'; }
    projForm.reset(); localStorage.removeItem('projAuto'); beep('success'); toast('Project request sent!');
    window.scrollTo({top:0, behavior:'smooth'});
  }catch(err){
    if(projStatus){ projStatus.textContent = 'Could not upload now. Email docs to info@amcspark.com'; projStatus.style.color='var(--danger)'; }
    toast('Upload failed — try email'); beep('fail');
  }finally{ hideLoader(); }
});

// ---------- Command palette (only if markup exists) ----------
const palette = qs('#palette');
if (palette){
  const palInput = qs('#palInput');
  const palList  = qs('#palList');
  const targets = [
    {name:'Services', href:'#services'}, {name:'Supply', href:'#supply'},
    {name:'Projects', href:'#projects'}, {name:'Downloads', href:'#downloads'},
    {name:'Forms', href:'#forms'}, {name:'Contact', href:'#contact'}
  ];
  function openPalette(){
    palette.classList.add('show');
    palette.setAttribute('aria-hidden','false');
    if(palInput){ palInput.value=''; renderList(''); palInput.focus(); }
  }
  function closePalette(){
    palette.classList.remove('show');
    palette.setAttribute('aria-hidden','true');
  }
  function renderList(q){
    if(!palList) return;
    palList.innerHTML='';
    targets.filter(t=>t.name.toLowerCase().includes(q.toLowerCase())).forEach((t,i)=>{
      const li=document.createElement('li');
      li.setAttribute('role','option');
      li.setAttribute('tabindex','0');
      li.setAttribute('aria-selected', i===0 ? 'true':'false');
      li.innerHTML = `<span>${t.name}</span><span class="help">${t.href}</span>`;
      li.addEventListener('click',()=>{ location.hash=t.href; closePalette(); });
      li.addEventListener('keydown',(e)=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); li.click(); } });
      palList.appendChild(li);
    });
  }
  palInput?.addEventListener('input', ()=>renderList(palInput.value));
  palette.addEventListener('click',(e)=>{ if(e.target===palette) closePalette(); });

  document.addEventListener('keydown',(e)=>{
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); palette.classList.contains('show') ? closePalette() : openPalette(); }
    if(e.key==='/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){ e.preventDefault(); openPalette(); }
    if(e.key==='Escape' && palette.classList.contains('show')) closePalette();
  });
}

// ---------- NOTE ----------
// Removed CT/PT helper & old Quick Quote modal JS since they’re not in the current HTML.
// If you re-add those sections later, ping me and I’ll wire them back up neatly.
