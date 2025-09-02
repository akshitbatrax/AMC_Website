// ===== AMC Spark Admin Dashboard =====
(() => {
  // ---------- Helpers ----------
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const fmtISO = d => (d instanceof Date ? d : new Date(d)).toISOString();
  const escapeHtml = s => (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  const stripTags = html => (html||'').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g,'').trim();

  const toast = (msg, ms=1600) => {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'), ms);
  };

  const htmlRoot = document.documentElement;
  const themeToggle = $('#themeToggle');
  themeToggle?.addEventListener('click', ()=>{
    const next = htmlRoot.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    htmlRoot.setAttribute('data-theme', next);
    try{ localStorage.setItem('amc-admin-theme', next); }catch{}
  });
  // restore persisted theme
  try{
    const savedTheme = localStorage.getItem('amc-admin-theme');
    if(savedTheme) htmlRoot.setAttribute('data-theme', savedTheme);
  }catch{}

  // ---------- Tabs ----------
  $$('.menu .item').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $$('.menu .item').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $$('.tab').forEach(s=>s.classList.remove('show'));
      $('#tab-'+tab).classList.add('show');
    });
  });

  // ---------- Filters & controls ----------
  const inQ = $('#q'), selKind = $('#kind'), selStatus = $('#status');
  const autoRefresh = $('#autoRefresh');
  const btnRefresh = $('#refreshBtn');
  const btnExportCsv = $('#exportCsv');
  const bulkOpen = $('#bulkOpen'), bulkWip = $('#bulkWip'), bulkRes = $('#bulkResolved');

  let FILTERS = { q:'', kind:'', status:'' };
  inQ?.addEventListener('input', ()=>{ FILTERS.q = (inQ.value||'').trim(); fetchAndRender(); });
  selKind?.addEventListener('change', ()=>{ FILTERS.kind = selKind.value || ''; fetchAndRender(); });
  selStatus?.addEventListener('change', ()=>{ FILTERS.status = selStatus.value || ''; fetchAndRender(); });

  btnRefresh?.addEventListener('click', fetchAndRender);
  btnExportCsv?.addEventListener('click', ()=> exportCsv(VIEW.items));

  // ---------- Drawer ----------
  const drawer = $('#drawer'), dClose = $('#dClose'), dStatus = $('#dStatus'), dNote = $('#dNote');
  const dEmail = $('#dEmail'), dSubject = $('#dSubject'), dSave = $('#dSave');
  const dTicket = $('#dTicket'), dMeta = $('#dMeta'), dFields = $('#dFields'), dFiles = $('#dFiles'), dHist = $('#dHist');

  dClose?.addEventListener('click', ()=> drawerClose());
  dEmail?.addEventListener('change', ()=>{
    dSubject.disabled = !dEmail.checked;
    if(dEmail.checked && !dSubject.value && dTicket.textContent.trim()){
      dSubject.value = `Update on Ticket ${dTicket.textContent.trim()}`;
    }
  });

  function drawerOpen(item){
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
    dTicket.textContent = item.ticket;
    dMeta.textContent = `${item.kind} • ${item.email || '—'} • ${fmtISO(item.ts)}`;
    dStatus.value = item.status;
    dNote.value = item.note || '';
    dEmail.checked = false; dSubject.value = ''; dSubject.disabled = true;

    // fields
    dFields.innerHTML = Object.entries(item.fields||{}).map(([k,v])=>(
      `<div><span class="muted">${escapeHtml(k)}</span><div>${escapeHtml(String(v))}</div></div>`
    )).join('') || '<div class="muted">—</div>';

    // attachments
    dFiles.innerHTML = (item.attachments||[]).map(a=>(
      `<a class="badge" href="/uploads/${encodeURIComponent(a)}" target="_blank" rel="noopener">${escapeHtml(a)}</a>`
    )).join(' ') || '<span class="muted">—</span>';

    // history
    dHist.innerHTML = (item.history||[]).slice().reverse().map(h=>(
      `<div style="padding:8px 0;border-bottom:1px dashed var(--line)">
         <div><b>${escapeHtml(h.by||'admin')}</b> <span class="muted">• ${escapeHtml(h.ts||'')}</span></div>
         <div class="muted">Status: ${escapeHtml((h.status||'').toUpperCase())}${h.email_sent?' • Email sent':''}</div>
         ${h.note?`<div style="margin-top:4px">${escapeHtml(h.note)}</div>`:''}
       </div>`
    )).join('') || '<div class="muted">No history.</div>';

    dSave.onclick = async ()=>{
      const payload = {
        status: dStatus.value,
        note: (dNote.value||'').trim(),
        email_client: !!dEmail.checked,
        email_subject: (dSubject.value||'').trim() || `Update on Ticket ${item.ticket}`
      };
      try{
        dSave.disabled = true;
        const ok = await api.patchTicket(item.ticket, payload);
        if(!ok) throw new Error('Save failed');
        toast('Saved');
        drawerClose();
        // optimistic local update
        const idx = VIEW.items.findIndex(x=>x.ticket===item.ticket);
        if(idx>-1){
          VIEW.items[idx].status = payload.status;
          VIEW.items[idx].note = payload.note;
          if(payload.status==='resolved') VIEW.items[idx].overdue = false;
          VIEW.items[idx].history = [{ts:new Date().toISOString(), by:'admin', status:payload.status, note:payload.note, email_sent:!!payload.email_client}, ...(VIEW.items[idx].history||[])];
        }
        renderAll();
      }catch(e){ console.error(e); toast('Could not save'); }
      finally{ dSave.disabled = false; }
    };
  }
  function drawerClose(){
    drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true');
  }

  // ---------- API ----------
  const api = {
    async getTickets(){
      const p = new URLSearchParams();
      if(FILTERS.q) p.set('q', FILTERS.q);
      if(FILTERS.kind) p.set('kind', FILTERS.kind);
      if(FILTERS.status) p.set('status', FILTERS.status);
      const r = await fetch('/admin/api/tickets?'+p.toString(), {credentials:'same-origin'});
      if(r.status===401){ location.href='/admin/login'; return {ok:false, items:[]}; }
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();

    },
    async patchTicket(ticket, payload){
      const r = await fetch(`/admin/api/tickets/${encodeURIComponent(ticket)}`, {
        method:'PATCH', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
        body: JSON.stringify(payload)
      });
      if (r.status === 401) {
        try { if (timer) clearInterval(timer); } catch {}
        if (!location.pathname.startsWith('/admin/login')) {
          const next = encodeURIComponent(location.pathname + location.search);
          location.assign(`/admin/login?next=${next}`);
        }
        return false;
      }
      return r.ok;
    }
  };

  // ---------- State ----------
  const VIEW = { items:[], charts:{} };

  function normalize(x){
    return {
      ticket: x.ticket,
      kind: x.kind || 'Contact',
      status: (x.status||'open').toLowerCase(),
      note: x.note || '',
      history: x.history || [],
      fields: x.fields || {},
      attachments: x.attachments || [],
      ts: x.ts ? new Date(x.ts) : new Date(),
      email: x.client_email || (x.fields||{})['Email'] || '',
      name: (x.fields||{})['Name'] || (x.fields||{})['Organisation / Dept'] || '',
      phone: (x.fields||{})['Phone'] || '',
      msg: (x.fields||{})['Notes'] || (x.fields||{})['Message'] || '',
      overdue: !!x.overdue,
      ageHours: Number(x.age_hours || 0)
    };
  }

  // ---------- Render: KPIs ----------
  function renderKPIs(list){
    const total = list.length;
    const open  = list.filter(i=>i.status==='open').length;
    const wip   = list.filter(i=>i.status==='wip').length;
    const res   = list.filter(i=>i.status==='resolved').length;
    $('#kTotal').textContent = total;
    $('#kOpen').textContent  = open;
    $('#kWip').textContent   = wip;
    $('#kRes').textContent   = res;
    $('#cOpen').textContent = open; $('#cWip').textContent = wip; $('#cResolved').textContent = res;
  }

  // ---------- Render: Kanban ----------
  function ticketCard(t){
    const card = document.createElement('div');
    card.className = `ticket ${t.status} ${t.overdue?'overdue':''}`;
    card.draggable = true;
    card.dataset.ticket = t.ticket;
    card.innerHTML = `
      <div class="t-head">
        <div class="title">${escapeHtml(t.name || '(no name)')} <span class="badge">${escapeHtml(t.kind)}</span></div>
        <span class="muted">${t.ageHours.toFixed(1)}h</span>
      </div>
      <div class="meta">
        <span class="badge">#${escapeHtml(t.ticket)}</span>
        ${t.email ? `<span class="badge">${escapeHtml(t.email)}</span>` : ''}
      </div>
      <div class="actions">
        <button class="btn" data-act="edit">Edit</button>
        <button class="btn" data-act="open">Open</button>
        <button class="btn" data-act="wip">WIP</button>
        <button class="btn" data-act="res">Resolve</button>
      </div>
    `;
    card.querySelector('[data-act="edit"]').onclick = ()=> drawerOpen(t);
    card.querySelector('[data-act="open"]').onclick = ()=> quickUpdate(t.ticket,'open');
    card.querySelector('[data-act="wip"]').onclick  = ()=> quickUpdate(t.ticket,'wip');
    card.querySelector('[data-act="res"]').onclick  = ()=> quickUpdate(t.ticket,'resolved');

    card.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', t.ticket);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', ()=> card.classList.remove('dragging'));
    return card;
  }
  function renderKanban(list){
    const lanes = { open:$('#lane-open'), wip:$('#lane-wip'), resolved:$('#lane-resolved') };
    Object.values(lanes).forEach(n=> n.innerHTML = '');
    list.forEach(t=> lanes[t.status]?.appendChild(ticketCard(t)));
  }
  // lane drop handlers
  $$('.lane').forEach(l=>{
    l.addEventListener('dragover', e=> e.preventDefault());
    l.addEventListener('drop', async e=>{
      e.preventDefault();
      const ticket = e.dataTransfer.getData('text/plain');
      const to = l.id.replace('lane-','');
      if(!ticket || !to) return;
      await quickUpdate(ticket, to);
    });
  });

  async function quickUpdate(ticket, status){
    const ok = await api.patchTicket(ticket, {status, note:'', email_client:false});
    if(!ok){ toast('Update failed'); return; }
    const it = VIEW.items.find(x=>x.ticket===ticket);
    if(it){ it.status = status; if(status==='resolved') it.overdue=false; }
    toast(`Marked ${status.toUpperCase()}`);
    renderAll();
  }

  // ---------- Render: Table ----------
  function renderTable(list){
    if(!list.length){ $('#grid').innerHTML = `<div class="card muted">No submissions.</div>`; return; }
    const rows = list.map(r=>{
      const files = (r.attachments||[]).map(a=>`<a class="badge" href="/uploads/${encodeURIComponent(a)}" target="_blank" rel="noopener">${escapeHtml(a)}</a>`).join(' ');
      const notesShort = escapeHtml(stripTags(r.msg || r.note || '')).slice(0,160);
      const trClass = `row row-${r.status} ${r.overdue ? 'overdue' : ''}`;
      return `
        <tr data-ticket="${r.ticket}" class="${trClass}">
          <td><input type="checkbox" class="row-select" /></td>
          <td>
            <div><span class="badge">${escapeHtml(r.kind)}</span> <span class="muted">#${escapeHtml(r.ticket)}</span></div>
            <div class="muted">${fmtISO(r.ts)}</div>
          </td>
          <td>
            <div><b>${escapeHtml(r.name||'')}</b></div>
            <div class="muted">${escapeHtml(r.email||'')}</div>
            <div class="muted">${escapeHtml(r.phone||'')}</div>
          </td>
          <td>${notesShort || ''}</td>
          <td>${files || ''}</td>
          <td>
            <div class="muted">${r.status.toUpperCase()}</div>
            <div class="muted">${r.ageHours.toFixed(1)}h</div>
          </td>
          <td class="row-actions">
            <button class="btn" data-act="edit">Edit</button>
            <button class="btn" data-act="open">Open</button>
            <button class="btn" data-act="wip">WIP</button>
            <button class="btn" data-act="res">Resolve</button>
          </td>
        </tr>
      `;
    }).join('');
    $('#grid').innerHTML = `
      <div class="table">
        <table>
          <thead><tr>
            <th style="width:38px;"><input type="checkbox" id="rowSelectAll" /></th>
            <th>Type / Ticket</th>
            <th>Contact</th>
            <th>Notes / Message</th>
            <th>Files</th>
            <th>Status / Age</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    // actions
    $$('#grid tbody tr').forEach(tr=>{
      const ticket = tr.dataset.ticket;
      $('[data-act="edit"]', tr).onclick = ()=> drawerOpen(VIEW.items.find(x=>x.ticket===ticket));
      $('[data-act="open"]', tr).onclick = ()=> quickUpdate(ticket,'open');
      $('[data-act="wip"]',  tr).onclick = ()=> quickUpdate(ticket,'wip');
      $('[data-act="res"]',  tr).onclick = ()=> quickUpdate(ticket,'resolved');
    });

    // select all
    const selAll = $('#rowSelectAll');
    selAll?.addEventListener('change', ()=>{
      $$('.row-select').forEach(cb=> cb.checked = selAll.checked);
    });

    // bulk buttons
    const getSelectedTickets = () => $$('#grid .row-select:checked').map(cb=> cb.closest('tr').dataset.ticket);
    bulkOpen.onclick = ()=> bulkUpdate(getSelectedTickets(), 'open');
    bulkWip.onclick  = ()=> bulkUpdate(getSelectedTickets(), 'wip');
    bulkRes.onclick  = ()=> bulkUpdate(getSelectedTickets(), 'resolved');
  }

  async function bulkUpdate(tickets, status){
    if(!tickets.length) return toast('Select rows first');
    await Promise.all(tickets.map(t=> api.patchTicket(t, {status, note:'', email_client:false})));
    VIEW.items.forEach(it=>{ if(tickets.includes(it.ticket)){ it.status=status; if(status==='resolved') it.overdue=false; }});
    toast(`Updated ${tickets.length} → ${status.toUpperCase()}`);
    renderAll();
  }

  // ---------- Charts & Heatmap ----------
  function renderCharts(list){
    // destroy old
    Object.values(VIEW.charts).forEach(c=>{ try{ c.destroy(); }catch{} });
    VIEW.charts = {};

    // labels last 14 days
    const days = [...Array(14)].map((_,i)=>{
      const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()- (13-i)); return d;
    });
    const dayKey = d => d.toISOString().slice(0,10);
    const counts = days.map(d=>{
      const k = dayKey(d);
      return list.filter(x=> dayKey(x.ts)===k).length;
    });

    const ctxTrend = $('#cTrend')?.getContext('2d');
    if(ctxTrend){
      VIEW.charts.trend = new Chart(ctxTrend, {
        type:'line',
        data:{ labels:days.map(d=>d.toISOString().slice(5,10)), datasets:[{ label:'Tickets', data:counts, tension:.3 }] },
        options:{ plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } }
      });
    }

    const byType = groupCount(list.map(x=> x.kind || 'Contact'));
    const ctxTypes = $('#cTypes')?.getContext('2d');
    if(ctxTypes){
      VIEW.charts.types = new Chart(ctxTypes, {
        type:'doughnut',
        data:{ labels:Object.keys(byType), datasets:[{ data:Object.values(byType) }] },
        options:{ plugins:{ legend:{ position:'bottom' } } }
      });
    }

    const byStatus = { open:0, wip:0, resolved:0 };
    list.forEach(x=>{ if(byStatus[x.status]!=null) byStatus[x.status]++; });
    const ctxStatus = $('#cStatus')?.getContext('2d');
    if(ctxStatus){
      VIEW.charts.status = new Chart(ctxStatus, {
        type:'doughnut',
        data:{ labels:['Open','WIP','Resolved'], datasets:[{ data:[byStatus.open, byStatus.wip, byStatus.resolved] }] },
        options:{ plugins:{ legend:{ position:'bottom' } } }
      });
    }

    // Kind × Status (stacked bars)
    const kinds = Array.from(new Set(list.map(x=>x.kind || 'Contact')));
    const ksData = { open:[], wip:[], resolved:[] };
    kinds.forEach(k=>{
      ksData.open.push(list.filter(x=>x.kind===k && x.status==='open').length);
      ksData.wip.push(list.filter(x=>x.kind===k && x.status==='wip').length);
      ksData.resolved.push(list.filter(x=>x.kind===k && x.status==='resolved').length);
    });
    const ctxKS = $('#cKindStatus')?.getContext('2d');
    if(ctxKS){
      VIEW.charts.kindstatus = new Chart(ctxKS, {
        type:'bar',
        data:{
          labels:kinds,
          datasets:[
            { label:'Open', data:ksData.open },
            { label:'WIP', data:ksData.wip },
            { label:'Resolved', data:ksData.resolved }
          ]
        },
        options:{ responsive:true, scales:{ x:{ stacked:true }, y:{ stacked:true, beginAtZero:true } } }
      });
    }

    // Heatmap 7x24 (UTC)
    const grid = $('#heatmap');
    if(grid){
      grid.innerHTML = '';
      const counts = Array.from({length:7},()=> Array(24).fill(0));
      list.forEach(x=>{
        const d = new Date(x.ts);
        const dow = (d.getUTCDay()+6)%7; // Mon=0
        const h = d.getUTCHours();
        counts[dow][h] += 1;
      });
      const flatMax = Math.max(1, ...counts.flat());
      for(let r=0;r<7;r++){
        for(let c=0;c<24;c++){
          const v = counts[r][c];
          const cell = document.createElement('div');
          cell.className = 'cell';
          const level = v===0 ? 0 : Math.min(5, 1+Math.floor((v/flatMax)*4));
          if(level) cell.dataset.v = String(level);
          grid.appendChild(cell);
        }
      }
    }
  }

  function groupCount(arr){
    const m = {}; arr.forEach(k=> m[k]=(m[k]||0)+1); return m;
  }

  // ---------- CSV ----------
  function exportCsv(items){
    if(!items.length) return toast('Nothing to export');
    const headers = ['ticket','kind','status','name','email','phone','message','age_hours','ts'];
    const toRow = t => [
      t.ticket, t.kind, t.status, (t.name||''), (t.email||''), (t.phone||''),
      stripTags(t.msg||t.note||'').replace(/\s+/g,' ').slice(0,500),
      String(t.ageHours||0), fmtISO(t.ts)
    ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',');
    const csv = [headers.join(','), ...items.map(toRow)].join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `amc_tickets_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- Fetch + Render ----------
  async function fetchAndRender(){
    try{
      const data = await api.getTickets();
      if(!data?.ok){ toast('Load failed'); return; }
      VIEW.items = (data.items||[]).map(normalize).sort((a,b)=> b.ts - a.ts);
      renderAll();
    }catch(e){ console.error(e); toast('Network error'); }
  }

  function renderAll(){
    renderKPIs(VIEW.items);
    renderKanban(VIEW.items);
    renderTable(VIEW.items);
    renderCharts(VIEW.items);
  }

  // ---------- Auto refresh ----------
  let timer = null;
  function startAuto(){
    if(timer) clearInterval(timer);
    if(autoRefresh?.checked){
      timer = setInterval(fetchAndRender, 30000);
    }
  }
  autoRefresh?.addEventListener('change', startAuto);

  // Init
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden && document.querySelector('#grid')) fetchAndRender(); });
  if (document.querySelector('#grid')) { fetchAndRender(); startAuto(); }
})();
