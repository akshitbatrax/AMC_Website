/* ---------- image storage ----------
   The original page shipped a hardcoded default company logo and stamp/signature
   image as base64 PNGs. Those exact bytes were not reliably transcribable here,
   so defaults are left empty rather than risk embedding wrong/corrupted image
   data. Upload your logo and stamp once via the buttons below (or Load your
   previously-saved invoice JSON, which stores them for you). */
const DEFAULT_LOGO='';
const DEFAULT_STAMP='';
const imgs={logo:DEFAULT_LOGO,stamp:DEFAULT_STAMP};
['logo','stamp'].forEach(k=>{if(!imgs[k])return;const p=document.getElementById(k+'_prev');p.src=imgs[k];p.style.display='inline-block';});
function loadImg(e,key){
  const f=e.target.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=()=>{imgs[key]=r.result;const p=document.getElementById(key+'_prev');p.src=r.result;p.style.display='inline-block';render();};
  r.readAsDataURL(f);
}

/* ---------- items ---------- */
let items=[];
function addItem(data){
  const it=data||{desc:'',hsn:'',qty:'1',rate:'0',per:'Nos'};
  items.push(it); renderItemsForm(); render();
}
function renderItemsForm(){
  const tb=document.getElementById('itemsBody'); tb.innerHTML='';
  items.forEach((it,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td><textarea oninput="upd(${i},'desc',this.value)" style="min-height:38px">${esc(it.desc)}</textarea></td>
      <td><input value="${esc(it.hsn)}" oninput="upd(${i},'hsn',this.value)"></td>
      <td><input value="${esc(it.qty)}" oninput="upd(${i},'qty',this.value)"></td>
      <td><input value="${esc(it.rate)}" oninput="upd(${i},'rate',this.value)"></td>
      <td><input value="${esc(it.per)}" oninput="upd(${i},'per',this.value)"></td>
      <td><button class="del-btn" onclick="delItem(${i})">×</button></td>`;
    tb.appendChild(tr);
  });
}
function upd(i,k,v){items[i][k]=v;render();}
function delItem(i){items.splice(i,1);renderItemsForm();render();}

/* ---------- helpers ---------- */
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function nl2br(s){return esc(s).replace(/\n/g,'<br>');}
function num(v){const n=parseFloat(String(v).replace(/,/g,''));return isNaN(n)?0:n;}
function fmt(n){return n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});}
function g(id){return document.getElementById(id).value;}

/* ---------- number to words (Indian) ---------- */
function inWords(n){
  n=Math.floor(n);
  if(n===0)return 'Zero';
  const a=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const b=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function two(x){return x<20?a[x]:b[Math.floor(x/10)]+(x%10?' '+a[x%10]:'');}
  function three(x){return (x>=100?a[Math.floor(x/100)]+' Hundred'+(x%100?' ':''):'')+(x%100?two(x%100):'');}
  let out='';
  const cr=Math.floor(n/10000000);n%=10000000;
  const lk=Math.floor(n/100000);n%=100000;
  const th=Math.floor(n/1000);n%=1000;
  const hu=n;
  if(cr)out+=three(cr)+' Crore ';
  if(lk)out+=two(lk)+' Lakh ';
  if(th)out+=two(th)+' Thousand ';
  if(hu)out+=three(hu);
  return out.trim().replace(/\s+/g,' ');
}
function amountWords(total,curword){
  const rs=Math.floor(total);const ps=Math.round((total-rs)*100);
  let s=curword+' '+inWords(rs)+' Rupees';
  if(ps>0)s+=' and '+inWords(ps)+' Paise';
  return s+' Only.';
}

/* ---------- auto tax type from place of supply + buyer GSTIN (seller is in Haryana, code 06) ---------- */
const GST_STATE_CODES={
  '01':'JAMMU AND KASHMIR','02':'HIMACHAL PRADESH','03':'PUNJAB','04':'CHANDIGARH','05':'UTTARAKHAND',
  '06':'HARYANA','07':'DELHI','08':'RAJASTHAN','09':'UTTAR PRADESH','10':'BIHAR','11':'SIKKIM',
  '12':'ARUNACHAL PRADESH','13':'NAGALAND','14':'MANIPUR','15':'MIZORAM','16':'TRIPURA','17':'MEGHALAYA',
  '18':'ASSAM','19':'WEST BENGAL','20':'JHARKHAND','21':'ODISHA','22':'CHHATTISGARH','23':'MADHYA PRADESH',
  '24':'GUJARAT','26':'DADRA AND NAGAR HAVELI AND DAMAN AND DIU','27':'MAHARASHTRA','29':'KARNATAKA',
  '30':'GOA','31':'LAKSHADWEEP','32':'KERALA','33':'TAMIL NADU','34':'PUDUCHERRY',
  '35':'ANDAMAN AND NICOBAR ISLANDS','36':'TELANGANA','37':'ANDHRA PRADESH','38':'LADAKH','97':'OTHER TERRITORY'
};
const SELLER_STATE_CODE='06'; // AMC Spark & Services is registered in Haryana

function stateCodeFromPos(pos){
  pos=(pos||'').trim();
  const m=pos.match(/^(\d{2})\s*-/);
  if(m&&GST_STATE_CODES[m[1]])return m[1];
  const low=pos.toLowerCase();
  for(const code in GST_STATE_CODES){
    if(low.includes(GST_STATE_CODES[code].toLowerCase()))return code;
  }
  return null;
}
function stateCodeFromGstin(gstin){
  const m=(gstin||'').trim().match(/^(\d{2})/);
  return m&&GST_STATE_CODES[m[1]]?m[1]:null;
}
function autoTaxType(){
  const codes=[stateCodeFromPos(g('inv_pos')),stateCodeFromGstin(g('b_gstin'))].filter(Boolean);
  if(codes.length&&codes.every(c=>c===SELLER_STATE_CODE))return 'cgstsgst';
  return 'igst'; // any non-Haryana signal (or no signal yet) locks IGST
}
function onPosInput(){ document.getElementById('tax_type').value=autoTaxType(); render(); }
function onGstinInput(){ document.getElementById('tax_type').value=autoTaxType(); render(); }

/* ---------- inline preview editing (edit directly on the rendered invoice) ---------- */
function CE(field){ return 'contenteditable="true" data-field="'+field+'" spellcheck="false"'; }
function CEI(i,field){ return 'contenteditable="true" data-item="'+i+'" data-itemfield="'+field+'" spellcheck="false"'; }
const CE_SINGLE_LINE_FIELDS=['inv_no','inv_date','inv_pos','inv_due','b_name','b_gstin','footer_note'];
(function(){
  const invoiceEl=document.getElementById('invoice');
  invoiceEl.addEventListener('keydown',function(e){
    const el=e.target;
    if(!(el.getAttribute&&el.getAttribute('contenteditable')==='true'))return;
    if(e.key==='Enter'){
      const multiline=el.dataset.field==='b_addr'||el.dataset.field==='b_ship'||el.dataset.itemfield==='desc';
      if(!multiline){ e.preventDefault(); el.blur(); }
    }
  });
  invoiceEl.addEventListener('blur',function(e){
    const el=e.target;
    if(!(el.getAttribute&&el.getAttribute('contenteditable')==='true'))return;
    const raw=(el.innerText||el.textContent||'').replace(/Â /g,' ');
    if(el.dataset.field){
      const field=el.dataset.field;
      const value=CE_SINGLE_LINE_FIELDS.includes(field)?raw.replace(/\n+/g,' ').trim():raw.replace(/\n+$/,'');
      const input=document.getElementById(field);
      if(input)input.value=value;
      if(field==='inv_pos'){ onPosInput(); return; }
      if(field==='b_gstin'){ onGstinInput(); return; }
      render();
    }else if(el.dataset.item!==undefined&&el.dataset.itemfield){
      const idx=parseInt(el.dataset.item,10), key=el.dataset.itemfield;
      if(items[idx])items[idx][key]=key==='desc'?raw.replace(/\n+$/,'').trim():raw.replace(/\n+/g,' ').trim();
      renderItemsForm();render();
    }
  },true);
})();

/* ---------- render invoice ---------- */
function render(){
  document.getElementById('b_ship').style.display=document.getElementById('b_ship_diff').checked?'block':'none';
  const cur=g('cur')||'₹', curword=g('curword')||'INR';
  const taxType=g('tax_type'); const rate=num(g('tax_rate'));
  let taxable=0;
  const rows=items.map((it,i)=>{
    const amt=num(it.qty)*num(it.rate); taxable+=amt;
    return `<tr>
      <td class="center">${i+1}</td>
      <td class="desc" ${CEI(i,'desc')}>${nl2br(it.desc)}</td>
      <td class="center" ${CEI(i,'hsn')}>${esc(it.hsn)}</td>
      <td class="center">${rate?rate+'%':'-'}</td>
      <td class="center" ${CEI(i,'qty')}>${esc(it.qty)}</td>
      <td class="right" ${CEI(i,'rate')}>${fmt(num(it.rate))}</td>
      <td class="center" ${CEI(i,'per')}>${esc(it.per)}</td>
      <td class="right">${fmt(amt)}</td>
    </tr>`;
  }).join('');

  let taxAmt=0,taxLines='',hsnHead='',hsnRows='',hsnCols=0;
  if(taxType==='igst'){
    taxAmt=taxable*rate/100;
    taxLines=`<tr><td colspan="7" class="right lbl">IGST ${rate.toFixed(2)}%</td><td class="right">${fmt(taxAmt)}</td></tr>`;
  }else if(taxType==='cgstsgst'){
    const half=taxable*rate/200; taxAmt=half*2;
    taxLines=`<tr><td colspan="7" class="right lbl">CGST ${(rate/2).toFixed(2)}%</td><td class="right">${fmt(half)}</td></tr>
      <tr><td colspan="7" class="right lbl">SGST ${(rate/2).toFixed(2)}%</td><td class="right">${fmt(half)}</td></tr>`;
  }
  let grand=taxable+taxAmt; let roundOff=0;
  if(document.getElementById('round_off').checked){
    const r=Math.round(grand); roundOff=r-grand; grand=r;
  }
  const totQty=items.reduce((s,it)=>s+num(it.qty),0);

  // HSN summary grouped
  const hsnMap={};
  items.forEach(it=>{const amt=num(it.qty)*num(it.rate);const k=it.hsn||'-';hsnMap[k]=(hsnMap[k]||0)+amt;});
  if(taxType==='igst'){
    for(const k in hsnMap){const tv=hsnMap[k];const ta=tv*rate/100;
      hsnRows+=`<tr><td class="center">${esc(k)}</td><td class="right">${fmt(tv)}</td><td class="center">${rate}%</td><td class="right">${fmt(ta)}</td><td class="right">${fmt(ta)}</td></tr>`;}
    hsnHead=`<tr><td rowspan="2" class="center bold">HSN/SAC</td><td rowspan="2" class="center bold">Taxable Value</td><td colspan="2" class="center bold">Integrated GST</td><td rowspan="2" class="center bold">Total Tax</td></tr><tr><td class="center bold">Rate</td><td class="center bold">Amount</td></tr>`;
    hsnCols=5;
  }else if(taxType==='cgstsgst'){
    for(const k in hsnMap){const tv=hsnMap[k];const h=tv*rate/200;
      hsnRows+=`<tr><td class="center">${esc(k)}</td><td class="right">${fmt(tv)}</td><td class="center">${rate/2}%</td><td class="right">${fmt(h)}</td><td class="center">${rate/2}%</td><td class="right">${fmt(h)}</td><td class="right">${fmt(h*2)}</td></tr>`;}
    hsnHead=`<tr><td rowspan="2" class="center bold">HSN/SAC</td><td rowspan="2" class="center bold">Taxable Value</td><td colspan="2" class="center bold">CGST</td><td colspan="2" class="center bold">SGST</td><td rowspan="2" class="center bold">Total Tax</td></tr><tr><td class="center bold">Rate</td><td class="center bold">Amount</td><td class="center bold">Rate</td><td class="center bold">Amount</td></tr>`;
    hsnCols=7;
  }

  const hsnSummary=hsnCols? `<table style="margin-top:-1px"><tbody>${hsnHead}${hsnRows}
     <tr><td class="center bold">TOTAL</td><td class="right bold">${fmt(taxable)}</td><td colspan="${hsnCols-3}"></td><td class="right bold">${fmt(taxAmt)}</td></tr></tbody></table>`:'';

  const logoCell=imgs.logo?`<img src="${imgs.logo}">`:`<span class="hint">Logo</span>`;
  const shipHtml=document.getElementById('b_ship_diff').checked?`<div style="margin-top:4px"><span class="lbl">Shipping Address:</span><br><span ${CE('b_ship')}>${nl2br(g('b_ship'))}</span></div>`:'';
  const refHtml=g('inv_ref')?`<div>${esc(g('inv_ref'))}</div>`:'';

  const html=`
  <table>
    <tr><td colspan="4" class="inv-title">TAX INVOICE</td></tr>
    <tr>
      <td class="logo-cell" rowspan="3">${logoCell}</td>
      <td style="width:230px"><span class="seller-name">${esc(g('s_name'))}</span><br>GSTIN: ${esc(g('s_gstin'))}</td>
      <td><span class="lbl">Invoice #:</span><br><span class="bold" ${CE('inv_no')}>${esc(g('inv_no'))}</span></td>
      <td><span class="lbl">Invoice Date:</span><br><span class="bold" ${CE('inv_date')}>${esc(g('inv_date'))}</span></td>
    </tr>
    <tr>
      <td rowspan="2">${nl2br(g('s_addr'))}${g('s_mobile')?'<br>Mobile: '+esc(g('s_mobile')):''}${g('s_email')?'<br>Email: '+esc(g('s_email')):''}</td>
      <td><span class="lbl">Place of Supply:</span><br><span class="bold" ${CE('inv_pos')}>${esc(g('inv_pos'))}</span></td>
      <td><span class="lbl">Due Date:</span><br><span class="bold" ${CE('inv_due')}>${esc(g('inv_due'))}</span></td>
    </tr>
    <tr>
      <td colspan="2"><span class="bold" ${CE('b_name')}>${esc(g('b_name'))}</span><br><span ${CE('b_addr')}>${nl2br(g('b_addr'))}</span><br>GSTIN: <span ${CE('b_gstin')}>${esc(g('b_gstin'))}</span>${refHtml}</td>
    </tr>
    <tr>
      <td colspan="4" class="no-b" style="border:1px solid #000!important">
        <span class="lbl">Customer Address</span><br>
        <span class="bold" ${CE('b_name')}>${esc(g('b_name'))}</span><br>
        GSTIN: <span ${CE('b_gstin')}>${esc(g('b_gstin'))}</span><br>
        <span class="lbl">Billing Address:</span><br><span ${CE('b_addr')}>${nl2br(g('b_addr'))}</span>${shipHtml}
      </td>
    </tr>
  </table>

  <table class="items" style="margin-top:-1px">
    <thead><tr>
      <th style="width:26px">#</th><th>Item</th><th style="width:60px">HSN/SAC</th>
      <th style="width:44px">Tax</th><th style="width:36px">Qty</th><th style="width:80px">Rate/Item</th>
      <th style="width:44px">Per</th><th style="width:100px">Amount</th>
    </tr></thead>
    <tbody>
      ${rows||'<tr><td colspan="8" class="center hint" style="padding:20px">Add a line item…</td></tr>'}
      <tr><td colspan="7" class="right lbl">Taxable Amount</td><td class="right bold">${fmt(taxable)}</td></tr>
      ${taxLines}
      ${document.getElementById('round_off').checked?`<tr><td colspan="7" class="right lbl">Round Off</td><td class="right">${fmt(roundOff)}</td></tr>`:''}
      <tr class="pay-row"><td colspan="4" class="right">TOTAL</td><td class="center">${totQty}</td><td colspan="2"></td><td class="right">${fmt(grand)}</td></tr>
    </tbody>
  </table>

  <table style="margin-top:-1px"><tr><td class="words-row">Amount Chargeable (In Words) : <span class="bold">${amountWords(grand,curword)}</span> <span ${CE('footer_note')}>${esc(g('footer_note'))}</span></td></tr></table>

  ${hsnSummary}

  <table style="margin-top:-1px"><tr class="pay-row"><td class="right" style="width:78%">AMOUNT PAYABLE</td><td class="right">${cur} ${fmt(grand)}</td></tr></table>

  <table style="margin-top:auto"><tr>
    <td style="width:52%">
      <span class="lbl">Bank Details:</span> ${esc(g('bk_bank'))}<br>
      <span class="lbl">Account Holder:</span> ${esc(g('bk_holder'))}<br>
      <span class="lbl">Account #:</span> ${esc(g('bk_acc'))}<br>
      <span class="lbl">IFSC Code:</span> ${esc(g('bk_ifsc'))}<br>
      <span class="lbl">Branch:</span> ${esc(g('bk_branch'))}
    </td>
    <td class="stamp-cell">
      ${imgs.stamp?`<img src="${imgs.stamp}">`:''}
      <span class="sign">Authorized Signatory</span>
    </td>
  </tr></table>
  `;
  document.getElementById('invoice').innerHTML=html;
  scheduleAutosave();
}

/* ---------- validation: bill cannot be generated until these pass ---------- */
function validateInvoice(){
  const errors=[]; const invalidEls=[];
  function req(id,label){
    const el=document.getElementById(id);
    if(!el.value.trim()){errors.push(label+' is required');invalidEls.push(el);}
  }
  req('b_name','Customer name');
  req('b_addr','Billing address');
  req('inv_no','Invoice number');
  req('inv_date','Invoice date');
  req('inv_pos','Place of supply');

  if(items.length===0){
    errors.push('Add at least one line item');
  }else{
    items.forEach((it,i)=>{
      if(!String(it.desc||'').trim())errors.push(`Line item ${i+1}: description is required`);
      if(!(num(it.qty)>0))errors.push(`Line item ${i+1}: quantity must be greater than 0`);
      if(!(num(it.rate)>0))errors.push(`Line item ${i+1}: rate must be greater than 0`);
    });
  }

  document.querySelectorAll('.field-invalid').forEach(e=>e.classList.remove('field-invalid'));
  invalidEls.forEach(e=>e.classList.add('field-invalid'));

  const banner=document.getElementById('validationBanner');
  if(errors.length){
    banner.style.display='block';
    banner.innerHTML='<strong>Fix the following before generating the invoice:</strong><ul>'+errors.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>';
    (invalidEls[0]||banner).scrollIntoView({behavior:'smooth',block:'center'});
    if(invalidEls[0])invalidEls[0].focus();
  }else{
    banner.style.display='none'; banner.innerHTML='';
  }
  return errors.length===0;
}
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.classList&&t.classList.contains('field-invalid')&&t.value&&t.value.trim())t.classList.remove('field-invalid');
});

/* ---------- shrink an element via zoom so it always fits within one A4 page ---------- */
function fitToOnePage(el,marginMm){
  const CSS_PX_PER_MM=96/25.4;
  const pageHeightPx=(297-marginMm*2)*CSS_PX_PER_MM;
  el.style.zoom='1';
  el.style.minHeight='0'; // ignore the screen-only cosmetic min-height - measure TRUE content height
  const natural=el.scrollHeight;
  if(natural<=pageHeightPx+1){
    // content already fits within one print page - stretch to fill it exactly (footer anchors to bottom via margin-top:auto)
    el.style.minHeight=pageHeightPx+'px';
    return 1;
  }
  const safety=0.97; // small margin for width-reflow differences between screen and print layout
  const scale=Math.min(1,(pageHeightPx*safety)/natural);
  el.style.zoom=String(scale);
  return scale;
}

function printInvoice(){
  if(document.activeElement)document.activeElement.blur(); // commit any in-progress preview edit first
  if(!validateInvoice())return;
  const el=document.getElementById('invoice');
  fitToOnePage(el,12);
  window.print();
  window.addEventListener('afterprint',function reset(){ el.style.zoom=''; el.style.minHeight=''; window.removeEventListener('afterprint',reset); });
}

/* ---------- print preview: opens a new tab showing exactly what will print ---------- */
function printPreview(){
  if(document.activeElement)document.activeElement.blur(); // commit any in-progress preview edit first
  if(!validateInvoice())return;

  const win=window.open('','_blank');
  if(!win){ alert('Please allow pop-ups for this page to open the print preview in a new tab.'); return; }

  const styleText=document.querySelector('style').innerHTML;
  // strip live-editing hooks - the preview tab is a read-only snapshot of the print output
  const invoiceHtml=document.getElementById('invoice').outerHTML
    .replace(/\s*contenteditable="true"/g,'')
    .replace(/\s*data-field="[^"]*"/g,'')
    .replace(/\s*data-item="[^"]*"/g,'')
    .replace(/\s*data-itemfield="[^"]*"/g,'')
    .replace(/\s*spellcheck="false"/g,'');

  win.document.open();
  win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8">'
    +'<title>Print Preview — '+esc(g('inv_no')||'Invoice')+'</title>'
    +'<style>'+styleText+`
      body{background:#525659;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}
      .pp-toolbar{position:sticky;top:0;z-index:10;background:#323639;color:#fff;padding:10px 18px;display:flex;align-items:center;gap:10px;box-shadow:0 2px 8px rgba(0,0,0,.3);}
      .pp-toolbar span{font-size:13px;font-weight:600;flex:1;}
      .pp-toolbar button{background:#4f46e5;color:#fff;border:0;padding:8px 14px;border-radius:6px;font-size:12.5px;cursor:pointer;font-weight:600;}
      .pp-toolbar button.secondary{background:#52565b;}
      .pp-page-wrap{padding:28px 0 60px;display:flex;justify-content:center;}
      .pp-page{width:210mm;height:297mm;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:12mm;box-sizing:border-box;overflow:hidden;}
      .pp-page .invoice{width:100%;min-height:273mm;}
      @media print{
        .pp-toolbar{display:none!important;}
        body{background:#fff;}
        .pp-page-wrap{padding:0;}
        .pp-page{box-shadow:none;padding:0;width:auto;height:auto;overflow:visible;}
      }
    </style></head><body>`
    +'<div class="pp-toolbar no-print">'
      +'<span>📄 Print Preview — this is exactly what will print or export as PDF (always fits one A4 page)</span>'
      +'<button class="secondary" onclick="window.close()">✕ Close</button>'
      +'<button onclick="window.print()">🖨️ Print</button>'
    +'</div>'
    +'<div class="pp-page-wrap"><div class="pp-page"><div class="invoice-wrap">'+invoiceHtml+'</div></div></div>'
    +'<script>(function(){'
      +'var el=document.querySelector(".pp-page .invoice");'
      +'var CSS_PX_PER_MM=96/25.4, pageHeightPx=(297-24)*CSS_PX_PER_MM;'
      +'el.style.zoom="1";'
      +'var natural=el.scrollHeight;'
      +'if(natural<=pageHeightPx+1)return;'
      +'var safety=0.97;'
      +'var scale=Math.min(1,(pageHeightPx*safety)/natural);'
      +'el.style.zoom=String(scale);'
    +'})();<\/script>'
    +'</body></html>');
  win.document.close();
}

/* ---------- PDF export (strict A4, no browser header/footer) ---------- */
async function downloadPDF(){
  if(document.activeElement)document.activeElement.blur(); // commit any in-progress preview edit first
  if(!validateInvoice())return;
  const btn=document.getElementById('pdfBtn');
  const original=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='⏳ Generating…';
  try{
    const el=document.getElementById('invoice');
    const canvas=await html2canvas(el,{scale:3,backgroundColor:'#ffffff'});
    const {jsPDF}=window.jspdf;
    const pageW=210,pageH=297,margin=10;
    const usableW=pageW-margin*2, usableH=pageH-margin*2;
    const pxPerMM=canvas.width/usableW;
    const naturalH=canvas.height/pxPerMM;
    const pdf=new jsPDF({unit:'mm',format:'a4',orientation:'portrait',compress:true});

    // always fit on exactly one A4 page - small bills sit at natural size,
    // large bills shrink proportionally to fit (never paginate to a 2nd page)
    const h=Math.min(naturalH,usableH);
    const w=usableW*(h/naturalH);
    pdf.addImage(canvas.toDataURL('image/jpeg',0.95),'JPEG',margin+(usableW-w)/2,margin,w,h);

    const name=(g('inv_no')||'invoice').replace(/[^\w-]/g,'_');
    pdf.save(name+'.pdf');
    saveToHistory('completed');
  }catch(err){
    alert('Could not generate PDF: '+err.message);
  }finally{
    btn.disabled=false; btn.innerHTML=original;
  }
}

/* ---------- save / load ---------- */
const fields=['s_name','s_gstin','s_addr','s_mobile','s_email','inv_no','inv_date','inv_pos','inv_due','inv_ref','b_name','b_gstin','b_addr','b_ship','tax_type','tax_rate','cur','curword','bk_bank','bk_holder','bk_acc','bk_ifsc','bk_branch','footer_note'];
function saveJSON(){
  const data={fields:{},items,imgs,round_off:document.getElementById('round_off').checked,b_ship_diff:document.getElementById('b_ship_diff').checked};
  fields.forEach(f=>data.fields[f]=g(f));
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=(g('inv_no')||'invoice').replace(/[^\w-]/g,'_')+'.json';a.click();
}
function applyInvoiceData(d){
  fields.forEach(k=>{if(d.fields&&k in d.fields)document.getElementById(k).value=d.fields[k];});
  items=d.items||[];
  if(d.imgs)Object.assign(imgs,d.imgs);
  document.getElementById('round_off').checked=!!d.round_off;
  document.getElementById('b_ship_diff').checked=!!d.b_ship_diff;
  ['logo','stamp'].forEach(k=>{if(imgs[k]){const p=document.getElementById(k+'_prev');p.src=imgs[k];p.style.display='inline-block';}});
  renderItemsForm();render();
}
function loadJSON(e){
  const f=e.target.files[0];if(!f)return;const r=new FileReader();
  r.onload=()=>{try{applyInvoiceData(JSON.parse(r.result));
  }catch(err){alert('Invalid file');}};
  r.readAsText(f);
}

/* ---------- invoice history (no backend - stored in this browser's localStorage) ---------- */
const HISTORY_KEY='amc_invoice_history_v1';
function getHistory(){ try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');}catch(e){return [];} }
function setHistory(h){ localStorage.setItem(HISTORY_KEY,JSON.stringify(h)); renderHistoryPanel(); }
function escJs(s){ return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function fmtMoney(n,cur){ return (cur||'₹')+' '+fmt(num(n)); }

function calcTotal(){
  const rate=num(g('tax_rate')); const taxType=g('tax_type');
  let taxable=0; items.forEach(it=>taxable+=num(it.qty)*num(it.rate));
  let grand=taxable+(taxType==='none'?0:taxable*rate/100);
  if(document.getElementById('round_off').checked)grand=Math.round(grand);
  return grand;
}

function saveToHistory(forceStatus){
  const invNo=g('inv_no'); if(!invNo)return;
  const hasContent=g('b_name').trim()||items.some(it=>String(it.desc||'').trim());
  if(!hasContent && !forceStatus)return;
  const hist=getHistory();
  const idx=hist.findIndex(h=>h.invNo===invNo);
  const status=forceStatus||(idx>=0?hist[idx].status:'pending');
  const rec={
    invNo, date:g('inv_date'), dueDate:g('inv_due'), buyerName:g('b_name')||'(no buyer name)',
    pos:g('inv_pos'), total:calcTotal(), cur:g('cur'), status, updatedAt:Date.now(),
    data:{fields:{},items:JSON.parse(JSON.stringify(items)),round_off:document.getElementById('round_off').checked,b_ship_diff:document.getElementById('b_ship_diff').checked}
  };
  fields.forEach(f=>rec.data.fields[f]=g(f));
  if(idx>=0)hist[idx]=rec; else hist.unshift(rec);
  setHistory(hist);
}
let autosaveTimer=null;
function scheduleAutosave(){ clearTimeout(autosaveTimer); autosaveTimer=setTimeout(()=>saveToHistory(),700); }

function openFromHistory(invNo){
  const rec=getHistory().find(h=>h.invNo===invNo); if(!rec)return;
  applyInvoiceData(rec.data);
  document.getElementById('validationBanner').style.display='none';
  closeHistoryPanel();
  window.scrollTo({top:0,behavior:'smooth'});
}
function deleteFromHistory(invNo,ev){
  if(ev)ev.stopPropagation();
  if(!confirm('Delete invoice '+invNo+' from history? This cannot be undone.'))return;
  setHistory(getHistory().filter(h=>h.invNo!==invNo));
}

function historyItemHtml(rec){
  const badge=rec.status==='completed'?'<span class="badge-completed">Completed</span>':'<span class="badge-pending">Pending</span>';
  const safeNo=escJs(rec.invNo);
  return '<div class="hist-item" onclick="openFromHistory(\''+safeNo+'\')">'
    +'<div class="row1"><span class="invno">'+esc(rec.invNo)+'</span>'+badge+'</div>'
    +'<div class="meta">'+esc(rec.buyerName)+(rec.date?' • '+esc(rec.date):'')+'</div>'
    +'<div class="row1" style="margin-top:6px"><span class="amt">'+esc(fmtMoney(rec.total,rec.cur))+'</span></div>'
    +'<div class="actions">'
      +'<button class="open-btn" onclick="event.stopPropagation();openFromHistory(\''+safeNo+'\')">Open</button>'
      +'<button class="del-btn2" onclick="deleteFromHistory(\''+safeNo+'\',event)">Delete</button>'
    +'</div></div>';
}
function renderHistoryPanel(){
  const body=document.getElementById('histBody'); if(!body)return;
  const hist=getHistory().sort((a,b)=>b.updatedAt-a.updatedAt);
  const pending=hist.filter(h=>h.status==='pending');
  const completed=hist.filter(h=>h.status==='completed');
  body.innerHTML=
    '<div class="hist-section-title">🟡 Pending ('+pending.length+')</div>'
    +(pending.length?pending.map(historyItemHtml).join(''):'<div class="hist-empty">No pending invoices.</div>')
    +'<div class="hist-section-title">⚪ Old / Completed ('+completed.length+')</div>'
    +(completed.length?completed.map(historyItemHtml).join(''):'<div class="hist-empty">No completed invoices yet.</div>');
  const badge=document.getElementById('historyBadge');
  if(pending.length){badge.style.display='flex';badge.textContent=pending.length;}
  else badge.style.display='none';
}
function openHistoryPanel(){ saveToHistory(); renderHistoryPanel(); document.getElementById('histOverlay').classList.add('open'); document.getElementById('histDrawer').classList.add('open'); }
function closeHistoryPanel(){ document.getElementById('histOverlay').classList.remove('open'); document.getElementById('histDrawer').classList.remove('open'); }

/* ---------- AMC (seller) static details ---------- */
const INV_PREFIX='ASAS';
const INV_SEQ_KEY='amc_invoice_seq';
function seedSeller(){
  const set=(id,v)=>document.getElementById(id).value=v;
  set('s_name','AMC SPARK AND SERVICES');
  set('s_gstin','06ACLFA4028K1ZC');
  set('s_addr','ROOM -001 C-7, Ground, RPS , RPS Palms,\nFaridabad\nFaridabad, HARYANA, 121002');
  set('s_mobile','+91 9220533011');
  set('s_email','info@amcspark.com');
  set('tax_type','igst'); set('tax_rate','18');
  set('bk_bank','Indian Bank');
  set('bk_holder','AMC SPARK AND SERVICES');
  set('bk_acc','8147608151');
  set('bk_ifsc','IDIB000G016');
  set('bk_branch','GREATER KAILASH');
}

/* ---------- date helpers ---------- */
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(d){return String(d.getDate()).padStart(2,'0')+' '+MONTHS[d.getMonth()]+' '+d.getFullYear();}
function addDays(d,n){const r=new Date(d);r.setDate(r.getDate()+n);return r;}
function fyAndMonth(d){
  const y=d.getFullYear(), m=d.getMonth()+1;
  const fyStart=m>=4?y:y-1, fyEnd=fyStart+1;
  return {fyShort:String(fyStart).slice(-2)+'-'+String(fyEnd).slice(-2),monAbbr:MONTHS[d.getMonth()].toUpperCase()};
}

/* ---------- incremental invoice number ---------- */
function nextInvoiceNumber(now){
  const {fyShort,monAbbr}=fyAndMonth(now);
  const key=fyShort+'_'+monAbbr;
  let seq={};
  try{seq=JSON.parse(localStorage.getItem(INV_SEQ_KEY)||'{}');}catch(e){seq={};}
  const n=(seq[key]||0)+1;
  seq[key]=n;
  localStorage.setItem(INV_SEQ_KEY,JSON.stringify(seq));
  return `${INV_PREFIX}/${fyShort}/${monAbbr}${String(n).padStart(4,'0')}`;
}

/* ---------- start a new invoice: AMC stays static, number auto-increments ---------- */
function newInvoice(){
  if(document.activeElement)document.activeElement.blur(); // commit any in-progress preview edit first
  saveToHistory(); // archive the outgoing draft (if it has any content) before resetting
  seedSeller();
  const now=new Date();
  document.getElementById('inv_no').value=nextInvoiceNumber(now);
  document.getElementById('inv_date').value=fmtDate(now);
  document.getElementById('inv_due').value=fmtDate(addDays(now,30));
  document.getElementById('inv_pos').value='';
  document.getElementById('inv_ref').value='';
  document.getElementById('b_name').value='';
  document.getElementById('b_gstin').value='';
  document.getElementById('b_addr').value='';
  document.getElementById('b_ship').value='';
  document.getElementById('b_ship_diff').checked=false;
  items=[];
  renderItemsForm();
  render();
}
newInvoice();
renderHistoryPanel();
