// Tiny helpers
const qs = (s, r=document)=>r.querySelector(s);
const qsa = (s, r=document)=>Array.from(r.querySelectorAll(s));

// Mobile nav
qs('#mobileMenuBtn')?.addEventListener('click', ()=> qs('#navlinks')?.classList.toggle('open'));

// Active section highlight
const sections = ['services','supply','process','projects','ctpt','capabilities','project-desk','contact']
  .map(id=>qs('#'+id)).filter(Boolean);
const links = qsa('.navlinks a');
const spy = new IntersectionObserver((entries)=>{
  entries.forEach(entry=>{
    const id = entry.target.id;
    const link = links.find(l=>l.getAttribute('href')==='#'+id);
    if(link) link.classList.toggle('active', entry.isIntersecting);
  });
},{rootMargin:'-40% 0px -50% 0px', threshold:0.01});
sections.forEach(s=>spy.observe(s));

// Reveal on scroll
const revealObs = new IntersectionObserver((ents)=>{
  ents.forEach(e=>{
    if(e.isIntersecting){ e.target.style.opacity='1'; e.target.style.transform='translateY(0)'; revealObs.unobserve(e.target); }
  });
},{threshold:.15});
qsa('.reveal').forEach(el=>revealObs.observe(el));

// Stats counters
const countObs = new IntersectionObserver((entries)=>{
  entries.forEach(entry=>{
    if(!entry.isIntersecting) return;
    const n = entry.target, to = parseInt(n.dataset.count || '0', 10); let cur = 0;
    const step = Math.ceil(Math.max(1,to/40));
    const t = setInterval(()=>{ cur+=step; if(cur>=to){cur=to; clearInterval(t);} n.textContent=cur; }, 40);
    countObs.unobserve(n);
  });
},{threshold:.4});
qsa('.stat .num').forEach(n=>countObs.observe(n));

// Carousel
const track = qs('#projectTrack');
const slides = track ? Array.from(track.children) : [];
let idx = 0;
const move = (i)=>{ if(!slides.length) return; idx=(i+slides.length)%slides.length; track.style.transform = `translateX(-${idx*100}%)`; };
qs('#prevSlide')?.addEventListener('click', ()=>move(idx-1));
qs('#nextSlide')?.addEventListener('click', ()=>move(idx+1));
if (slides.length) setInterval(()=>move(idx+1), 7000);
document.addEventListener('keydown', e=>{
  if (e.key==='ArrowLeft') move(idx-1);
  if (e.key==='ArrowRight') move(idx+1);
});

// Gallery filters
const chips = qsa('.chip'), gallery = qs('#gallery');
chips.forEach(ch=>{
  ch.addEventListener('click', ()=>{
    chips.forEach(c=>c.classList.remove('active')); ch.classList.add('active');
    const f = ch.dataset.filter;
    qsa('.gitem', gallery).forEach(el=>{ el.style.display = (f==='all' || el.dataset.cat===f) ? '' : 'none'; });
  });
});

// Scrollbar + back to top
const bar = qs('#scrollbar'), backTop = qs('#backTop'), hero = qs('.hero');
const btObs = new IntersectionObserver(([e])=> backTop.classList.toggle('show', !e.isIntersecting), {threshold:0.01});
hero && btObs.observe(hero);
window.addEventListener('scroll', ()=>{
  const h = document.documentElement; const p = (h.scrollTop)/(h.scrollHeight - h.clientHeight);
  bar.style.width = (p*100).toFixed(2) + '%';
}, {passive:true});

// Theme toggle (persist)
const themeBtn = qs('#themeBtn');
const setTheme = (m)=>{ document.documentElement.dataset.theme = m; localStorage.setItem('theme', m); };
setTheme(localStorage.getItem('theme') || 'light');
themeBtn?.addEventListener('click', ()=>{
  const cur = document.documentElement.dataset.theme || 'light';
  setTheme(cur === 'dark' ? 'light' : 'dark');
});

// Toast helper
const toast = (msg)=>{ const t = qs('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 1800); };

// Command palette
const palette = qs('#palette'), palInput = qs('#palInput'), palList = qs('#palList');
const targets = [
  {name:'Services', href:'#services'}, {name:'Supply', href:'#supply'}, {name:'Process', href:'#process'},
  {name:'Projects', href:'#projects'}, {name:'CT/PT', href:'#ctpt'}, {name:'Capabilities', href:'#capabilities'},
  {name:'Project Desk', href:'#project-desk'}, {name:'Contact', href:'#contact'}
];
function openPalette(){ palette.classList.add('show'); palette.setAttribute('aria-hidden','false'); palInput.value=''; renderList(''); palInput.focus(); }
function closePalette(){ palette.classList.remove('show'); palette.setAttribute('aria-hidden','true'); }
function renderList(q){
  palList.innerHTML='';
  targets.filter(t=>t.name.toLowerCase().includes(q.toLowerCase())).forEach((t,i)=>{
    const li=document.createElement('li'); li.setAttribute('role','option'); li.setAttribute('tabindex','0'); li.setAttribute('aria-selected', i===0 ? 'true':'false');
    li.innerHTML = `<span>${t.name}</span><span class="help">${t.href}</span>`;
    li.addEventListener('click',()=>{ location.hash=t.href; closePalette(); });
    li.addEventListener('keydown',(e)=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); li.click(); } });
    palList.appendChild(li);
  });
}
document.addEventListener('keydown',(e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); palette.classList.contains('show') ? closePalette() : openPalette(); }
  if(e.key==='/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){ e.preventDefault(); openPalette(); }
  if(e.key==='Escape' && palette.classList.contains('show')) closePalette();
});
palInput?.addEventListener('input', ()=>renderList(palInput.value));
palette?.addEventListener('click',(e)=>{ if(e.target===palette) closePalette(); });

// Hero canvas sparks
const c = qs('#sparkCanvas'); const ctx = c?.getContext('2d'); let W,H,parts=[];
function resize(){ if(!c) return; W=c.width= c.offsetWidth; H=c.height=c.offsetHeight; parts = Array.from({length:40},()=>({x:Math.random()*W, y:Math.random()*H, vx:(Math.random()-0.5)*.6, vy:(Math.random()-0.5)*.6, r:Math.random()*2+0.5})); }
function tick(){
  if(!ctx) return;
  ctx.clearRect(0,0,W,H);
  parts.forEach(p=>{
    p.x+=p.vx; p.y+=p.vy;
    if(p.x<0||p.x>W) p.vx*=-1; if(p.y<0||p.y>H) p.vy*=-1;
    ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
    const g = ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r*6); g.addColorStop(0,'rgba(17,181,255,.6)'); g.addColorStop(1,'rgba(17,181,255,0)');
    ctx.fillStyle=g; ctx.fill();
  });
  requestAnimationFrame(tick);
}
if(c){ const ro = new ResizeObserver(resize); ro.observe(c); resize(); tick(); }

// Year
qs('#year').textContent = new Date().getFullYear();

// Loader + sound
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
    g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.2, now+0.02); g.gain.exponentialRampToValueAtTime(0.0001, now+0.3);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(now+0.32);
  }catch{}
}
function showLoader(msg='Sending… good vibes only ✨'){
  qs('.loader-txt').textContent = msg;
  loader.classList.add('show'); loader.setAttribute('aria-hidden','false');
}
function hideLoader(){
  loader.classList.remove('show'); loader.setAttribute('aria-hidden','true');
}

// CT/PT helper
(function(){
  const ctRatio = qs('#ctRatio'), secCurrent = qs('#secCurrent'), burden = qs('#burden'), out = qs('#ctptOut');
  function parseRatio(r){
    if(!r) return null;
    const m = r.replace(/\s/g,'').match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/i);
    if(!m) return null;
    return {pri:parseFloat(m[1]), sec:parseFloat(m[2])};
  }
  const fmt = (n)=> (Math.round(n*100)/100).toString();
  function recalc(){
    const R = parseRatio(ctRatio.value); const Is = parseFloat(secCurrent.value||'0'); const VA = parseFloat(burden.value||'0');
    if(!R){ out.textContent='Enter CT ratio like 400/5'; out.style.color='var(--danger)'; return; }
    const ratio = R.pri / R.sec;
    const Ipri_est = Is * ratio;
    const Zsec = Is ? (VA / Math.max(Is, 0.0001)) : 0;
    const classSug = (VA<=10 && ratio<=300) ? '0.5 / 5P10' : (VA<=15 ? '0.5 / 10P10' : 'Check OEM');
    out.textContent = `Suggest: CT ${ratio.toFixed(0)}:1, Class ${classSug}, Iₚ≈${fmt(Ipri_est)} A. Approx Z₂≈${fmt(Zsec)} Ω.`;
    out.style.color = 'var(--muted-2)';
  }
  [ctRatio, secCurrent, burden].forEach(el=> el?.addEventListener('input', recalc));
})();

// Forms helpers
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const validPhone = v => /^[+\d][\d\s\-()]{7,}$/.test(v);
async function postJSON(url, data){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json().catch(()=>({ok:true}));
}
async function postForm(url, formData){
  const r = await fetch(url, { method:'POST', body: formData });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json().catch(()=>({ok:true}));
}

// Contact form
const contactForm = qs('#contactForm'); const contactStatus = qs('#contactStatus');
contactForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = qs('#cname').value.trim();
  const email = qs('#cemail').value.trim();
  const message = qs('#cmsg').value.trim();
  if(!name || !validEmail(email) || !message){ contactStatus.textContent='Please fill all required fields (valid email).'; contactStatus.style.color='var(--danger)'; return; }
  contactStatus.textContent='Sending…'; contactStatus.style.color='inherit'; showLoader('Sending your message…');
  try{
    const res = await postJSON('/api/contact', {name, email, message});
    contactStatus.textContent = res?.ok ? 'Message sent ✅' : 'Sent (check inbox) ✅';
    contactStatus.style.color = 'var(--ok)'; contactForm.reset(); beep('success'); toast('Message sent!');
  }catch(err){
    contactStatus.textContent = 'Could not send right now. Try email: info@amcspark.com';
    contactStatus.style.color = 'var(--danger)'; toast('Opening mail client…'); window.location.href='mailto:info@amcspark.com'; beep('fail');
  }finally{ hideLoader(); }
});

// Quick Quote modal
const quoteModal = qs('#quoteModal'); const openQuoteBtns = [qs('#openQuote'), qs('#openQuote2')].filter(Boolean); const closeQuote = qs('#closeQuote'); const qqForm = qs('#qqForm'); const qqStatus = qs('#qqStatus');
let lastFocus=null;
function trapFocus(e){
  if(!quoteModal.classList.contains('show')) return;
  const f = qsa('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', quoteModal).filter(x=>!x.hasAttribute('disabled'));
  const first=f[0], last=f[f.length-1];
  if(e.key==='Tab'){
    if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
  }
  if(e.key==='Escape'){ hideQuote(); }
}
function showQuote(){ lastFocus=document.activeElement; quoteModal.classList.add('show'); quoteModal.setAttribute('aria-hidden','false'); qs('#qqName').focus(); document.addEventListener('keydown', trapFocus); }
function hideQuote(){ quoteModal.classList.remove('show'); quoteModal.setAttribute('aria-hidden','true'); document.removeEventListener('keydown', trapFocus); lastFocus?.focus(); }
openQuoteBtns.forEach(btn=>btn.addEventListener('click', showQuote));
closeQuote?.addEventListener('click', hideQuote);
quoteModal?.addEventListener('click', (e)=>{ if(e.target===quoteModal) hideQuote(); });

// /api/quote
qqForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = qs('#qqName').value.trim(), email = qs('#qqEmail').value.trim(), phone = qs('#qqPhone').value.trim();
  const ptype = qs('#qqType').value, voltage = qs('#qqVoltage').value, when = qs('#qqWhen').value, notes = qs('#qqNotes').value;
  if(!name || !validEmail(email) || !validPhone(phone) || !ptype){ qqStatus.textContent='Please complete required fields.'; qqStatus.style.color='var(--danger)'; return; }
  qqStatus.textContent='Sending…'; qqStatus.style.color='inherit'; showLoader('Locking in your quote…');
  try{
    const res = await postJSON('/api/quote', {name, email, phone, ptype, voltage, when, notes});
    qqStatus.textContent = res?.ok ? 'Thanks! We’ll reply within 24 hours. ✅' : 'Submitted ✅';
    qqStatus.style.color='var(--ok)'; qqForm.reset(); beep('success'); toast('Quote request sent!');
    setTimeout(hideQuote, 600);
  }catch(err){
    qqStatus.textContent='Could not send now. Please email info@amcspark.com'; qqStatus.style.color='var(--danger)'; toast('Opening mail client…'); window.location.href='mailto:info@amcspark.com'; beep('fail');
  }finally{ hideLoader(); }
});

// Project Desk form with files
const projForm = qs('#projForm'); const projStatus = qs('#projStatus');
function saveAuto(){
  const ids=['org','name','email','phone','location','ptype','mode','voltage','podate','notes'];
  const d={}; ids.forEach(id=>{ const el=qs('#'+id); if(el) d[id]=el.value; });
  localStorage.setItem('projAuto', JSON.stringify(d));
}
function loadAuto(){
  try{ const d=JSON.parse(localStorage.getItem('projAuto')||'{}');
    Object.entries(d).forEach(([k,v])=>{ const el=qs('#'+k); if(el && v!=null) el.value=v; });
  }catch{}
}
loadAuto();
['org','name','email','phone','location','ptype','mode','voltage','podate','notes'].forEach(id=> qs('#'+id)?.addEventListener('input', saveAuto));

projForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = qs('#email').value.trim(); const phone = qs('#phone').value.trim();
  if(!projForm.checkValidity() || !validEmail(email) || !validPhone(phone)){
    projStatus.textContent = 'Please complete required fields with valid details.'; projStatus.style.color = 'var(--danger)'; return;
  }
  projStatus.textContent = 'Submitting…'; projStatus.style.color='inherit'; showLoader('Uploading files & creating ticket…');
  const fd = new FormData(projForm);
  const summary = {
    org: fd.get('org'), name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'),
    location: fd.get('location'), ptype: fd.get('ptype'), mode: fd.get('mode'),
    voltage: fd.get('voltage'), podate: fd.get('podate'), notes: fd.get('notes'),
    visit: !!qs('#visit')?.checked
  };
  fd.append('_summary', JSON.stringify(summary));
  try{
    const res = await postForm('/api/project', fd);
    projStatus.textContent = res?.ok ? 'Received. We will respond within 24 hours. ✅' : 'Submitted ✅';
    projStatus.style.color='var(--ok)'; projForm.reset(); localStorage.removeItem('projAuto'); beep('success'); toast('Project request sent!');
    window.scrollTo({top:0, behavior:'smooth'});
  }catch(err){
    projStatus.textContent = 'Could not upload now. Email docs to info@amcspark.com'; projStatus.style.color='var(--danger)'; toast('Upload failed — try email'); beep('fail');
  }finally{ hideLoader(); }
});

// Tabs (Services)
const tabButtons = qsa('.tabs .tab');
tabButtons.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    tabButtons.forEach(b=>b.classList.remove('active'));
    qsa('.pane').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    const pane = qs('#' + btn.getAttribute('aria-controls'));
    pane?.classList.add('active');
  });
});
