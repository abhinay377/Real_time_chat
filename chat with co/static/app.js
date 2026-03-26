/* ══════════════════════════════════════════════════════════════════
   Chat With Co — Frontend v4
   Features:
   • WhatsApp-style login page (phone+password only visible)
   • Loading splash screen
   • Status stories (24h expiry, text/photo/video, viewer count)
   • File type picker (photo, video, audio, document, file, location)
   • Permanent call history
   • Delete for everyone / delete for me
   • Online status indicators
   • Contact profile view with shared media
   • Right-click message context menu
   ══════════════════════════════════════════════════════════════════ */

const SRV    = '';
const WS_URL = `ws://${location.hostname}:8081`;

/* ── LocalStorage ─────────────────────────────────────────────── */
const LS = {
  g(k){try{return JSON.parse(localStorage.getItem('cwc_'+k))}catch{return null}},
  s(k,v){localStorage.setItem('cwc_'+k,JSON.stringify(v))},
  d(k){localStorage.removeItem('cwc_'+k)},
};
const lU  = ()=>LS.g('users')||{};
const sU  = u=>LS.s('users',u);
const lC  = uid=>(LS.g('cts')||{})[uid]||[];
const sC  = (uid,l)=>{const a=LS.g('cts')||{};a[uid]=l;LS.s('cts',a)};
const mKey= (a,b)=>[Math.min(a,b),Math.max(a,b)].join('_');
const lM  = (a,b)=>LS.g('m_'+mKey(a,b))||[];
const sM  = (a,b,l)=>LS.s('m_'+mKey(a,b),l);
let   seq = ()=>{let n=(LS.g('seq')||0)+1;LS.s('seq',n);return n};
let   sh  = s=>{let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h)+s.charCodeAt(i);return(h>>>0).toString(36)};

/* ── State ───────────────────────────────────────────────────── */
let token = LS.g('tok')||'';
let me    = LS.g('me');
let cts   = [], act = null, edF = null, profOpen = false, useSrv = false;
let pendingFile = null, pendingStoryFile = null;
let pendingReqs = [];
let currentStoryType = 'text';
let activeCallLog = [];
let storyGroups = [], currentStoryGroupIdx = 0, currentStoryIdx = 0, storyTimer = null;
let ctxMsgId = null, ctxMsgMine = false, ctxMsgContent = '';
let currentFileMimeFilter = null;

/* ── WebSocket ────────────────────────────────────────────────── */
let ws = null, wsReady = false, wsBackoff = 500, wsTimer = null;
let _cseq = 0;
const _pending = new Map();

/* ── Toast ───────────────────────────────────────────────────── */
function toast(msg, ic=''){
  const el=document.createElement('div'); el.className='toast';
  el.innerHTML=(ic?`<span>${ic}</span> `:'')+esc(String(msg));
  document.getElementById('toast-area').appendChild(el);
  setTimeout(()=>el.remove(), 3000);
}

/* ── Connection bar ──────────────────────────────────────────── */
function connBar(state, text){
  const bar=document.getElementById('conn-bar');
  bar.className=''; bar.classList.add('show',state);
  bar.textContent=text;
  if(state==='connected') setTimeout(()=>bar.classList.remove('show'),2000);
}

/* ── Upload progress ─────────────────────────────────────────── */
function setUploadProgress(pct){
  const bar=document.getElementById('upload-bar');
  bar.style.width=pct+'%';
  if(pct>=100) setTimeout(()=>bar.style.width='0%',700);
}

/* ── HTTP helper ─────────────────────────────────────────────── */
async function api(method, path, body, auth=true){
  if(!useSrv) return null;
  const opts={method, headers:{'Content-Type':'application/json'}};
  if(auth) opts.headers['Authorization']='Bearer '+token;
  if(body) opts.body=JSON.stringify(body);
  try{
    const r=await fetch(SRV+path, opts);
    return await r.json();
  }catch{ return null; }
}

async function probe(){
  try{
    const r=await fetch(SRV+'/api/ping',{signal:AbortSignal.timeout(2500)});
    const j=await r.json();
    useSrv=!!j.ok;
  }catch{ useSrv=false; }
}

/* ── WebSocket ───────────────────────────────────────────────── */
function connectWS(){
  if(!useSrv || !token) return;
  clearTimeout(wsTimer);
  connBar('connecting','Connecting…');
  try{
    ws = new WebSocket(WS_URL);
    ws.onopen = ()=>{ ws.send(JSON.stringify({type:'auth',token})); };
    ws.onmessage = e=>{ try{ dispatch(JSON.parse(e.data)); }catch(err){ console.warn(err); } };
    ws.onclose = ()=>{
      wsReady=false; ws=null;
      connBar('offline','Reconnecting…');
      wsTimer=setTimeout(connectWS, wsBackoff);
      wsBackoff=Math.min(wsBackoff*2, 8000);
    };
    ws.onerror = ()=>{};
  }catch(e){ console.error(e); }
}

/* ── WS dispatch ─────────────────────────────────────────────── */
function dispatch(msg){
  const t = msg.type;
  if(t==='auth_ok'){wsReady=true;wsBackoff=500;connBar('connected','● Connected');loadCts();if(act)loadMsgs(act._id,false);return;}
  if(t==='new_message'){onServerMessage(msg.msg);return;}
  if(t==='msg_sent'){const p=_pending.get(msg.client_id);if(p){p.resolve(msg.msg);_pending.delete(msg.client_id);}replaceOptimistic(msg.client_id,msg.msg);return;}
  if(t==='typing'){if(act&&act._id===msg.from)showTypingBubble();return;}
  if(t==='read_receipt'){markRead(msg.up_to_id);return;}
  if(t==='profile_update'){const c=cts.find(x=>x._id===msg.user_id);if(c){if(msg.name)c.name=msg.name;if(msg.status)c.status=msg.status;if(msg.avatar)c.avatar=msg.avatar;renderCts(cts);if(act&&act._id===msg.user_id){act.avatar=msg.avatar||act.avatar;document.getElementById('c-av').innerHTML=avatarHtml(act.avatar,40);}}return;}
  if(t==='presence_reply'){const c=cts.find(x=>x._id===msg.user_id);if(c){c.is_online=msg.online?1:0;renderCts(cts);}if(act&&act._id===msg.user_id)document.getElementById('c-st').textContent=msg.online?'online':'last seen recently';return;}
  if(t==='message_deleted'){const row=document.querySelector(`[data-id="${msg.message_id}"]`);if(row){const bub=row.querySelector('.bubble');if(bub)bub.innerHTML='<em style="color:var(--t3);font-size:13px">This message was deleted</em>';}return;}
  if(t==='contact_request'){if(!pendingReqs.find(r=>r.request_id===msg.request_id))pendingReqs.push(msg);updateReqBadge();toast(`${msg.from_name} wants to add you!`,'👋');return;}
  if(t==='contact_accepted'){toast(`${msg.by_name} accepted your request! 🎉`,'✅');loadCts();return;}
  if(t==='contact_declined'){toast(`${msg.by_name} declined your request`,'😔');return;}
  if(t==='call_offer'){onCallOffer(msg);return;}
  if(t==='call_answer'){onCallAnswer(msg);return;}
  if(t==='ice_candidate'){onIceCandidate(msg);return;}
  if(t==='call_ended'||t==='call_rejected'){onCallEnded();return;}
}

function wsSend(payload){
  if(ws&&ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify(payload));return true;}
  return false;
}

function wsSendMsg(payload,clientId){
  return new Promise((resolve,reject)=>{
    if(!wsReady){reject(new Error('ws not ready'));return;}
    const cid=clientId||('c'+(++_cseq));
    _pending.set(cid,{resolve,reject});
    ws.send(JSON.stringify({type:'ws_send',client_id:cid,...payload}));
    setTimeout(()=>{if(_pending.has(cid)){_pending.delete(cid);reject(new Error('timeout'));}},6000);
  });
}

function onServerMessage(m){
  const peerId=m.sender_id===me.id?m.receiver_id:m.sender_id;
  const isOpenChat=act&&(act._id===m.sender_id||act._id===m.receiver_id);
  if(isOpenChat){
    if(m.sender_id!==me.id){
      appendMessage({id:m.id,from:m.sender_id,to:m.receiver_id,txt:m.content,tp:m.msg_type||'text',
        ts:m.sent_at,rd:false,file_url:m.file_url,file_name:m.file_name,file_size:m.file_size,mime:m.mime_type},true);
    }
    wsSend({type:'read_ack',up_to_id:m.id,peer_id:m.sender_id});
  }
  const c=cts.find(x=>x._id===peerId);
  if(c){
    c.last_msg=m.content||'📎';c.last_msg_ts=m.sent_at;
    if(!isOpenChat&&m.sender_id!==me.id)c.unread=(c.unread||0)+1;
    renderCts(cts);
  }
  if(!isOpenChat&&m.sender_id!==me.id&&document.hidden&&Notification.permission==='granted'){
    const sender=cts.find(x=>x._id===m.sender_id);
    new Notification('New message'+(sender?' from '+sender.name:''),{body:m.content||'📎 File',icon:'/favicon.ico'});
  }
}

function replaceOptimistic(clientId,serverMsg){
  const msgs=document.getElementById('msgs');
  const tmp=msgs.querySelector(`[data-cid="${clientId}"]`);
  if(tmp){tmp.dataset.id=serverMsg.id||'';tmp.dataset.cid='';tmp.classList.remove('msg-pending');const tick=tmp.querySelector('.bub-tick');if(tick){tick.textContent=serverMsg.delivered?'✓✓':'✓';if(serverMsg.delivered)tick.classList.add('read');}}
}

function markRead(upToId){
  document.getElementById('msgs').querySelectorAll('.msg-row.out').forEach(row=>{
    const id=parseInt(row.dataset.id||'0');
    if(id&&id<=upToId){const tick=row.querySelector('.bub-tick');if(tick){tick.textContent='✓✓';tick.classList.add('read');}}
  });
}

/* ── Avatar ──────────────────────────────────────────────────── */
function avatarHtml(avatar,size=50){
  if(!avatar||avatar==='👤')return`<span style="font-size:${Math.round(size*.44)}px">👤</span>`;
  if(avatar.startsWith('data:')||avatar.startsWith('/')||avatar.startsWith('http'))
    return`<img class="av-img" src="${avatar}" alt="av" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover"/>`;
  return`<span style="font-size:${Math.round(size*.44)}px">${avatar}</span>`;
}

/* ── Auth ────────────────────────────────────────────────────── */
function authTab(t){
  document.getElementById('tab-si').classList.toggle('on',t==='si');
  document.getElementById('tab-su').classList.toggle('on',t==='su');
  document.getElementById('f-si').style.display=t==='si'?'flex':'none';
  document.getElementById('f-su').style.display=t==='su'?'flex':'none';
}
function busy(bid,lid,on,lbl){const b=document.getElementById(bid);if(!b)return;b.classList.toggle('busy',on);document.getElementById(lid).textContent=lbl;}
function devName(){return /Mobile/i.test(navigator.userAgent)?'Mobile':'Desktop';}

async function doSU(){
  const nm=gv('su-nm').trim(),ph=gv('su-ph').trim(),pw=gv('su-pw'),pw2=gv('su-pw2');
  if(!nm||!ph||!pw||!pw2){toast('Please fill all fields','⚠️');return;}
  if(pw.length<6){toast('Password must be ≥ 6 characters','⚠️');return;}
  if(pw!==pw2){toast('Passwords do not match','❌');return;}
  busy('su-btn','su-lbl',true,'Creating…');
  if(useSrv){
    const r=await api('POST','/api/register',{name:nm,phone:ph,password:pw,device:devName()},false);
    if(r&&r.token){token=r.token;me=r.user;LS.s('tok',token);LS.s('me',me);busy('su-btn','su-lbl',false,'Create Account');enterApp();return;}
    if(r&&r.error){toast(r.error,'❌');busy('su-btn','su-lbl',false,'Create Account');return;}
  }
  const u=lU();
  if(u[ph]){toast('Phone already registered','❌');busy('su-btn','su-lbl',false,'Create Account');return;}
  const id=seq();
  u[ph]={id,name:nm,phone:ph,pwd:sh(pw+ph),avatar:'👤',status:'Hey there!'};
  sU(u);me={id,name:nm,phone:ph,avatar:'👤',status:''};LS.s('me',me);
  busy('su-btn','su-lbl',false,'Create Account');enterApp();
}

async function doSI(){
  const ph=gv('si-ph').trim(),pw=gv('si-pw');
  if(!ph||!pw){toast('Fill all fields','⚠️');return;}
  busy('si-btn','si-lbl',true,'Signing in…');
  if(useSrv){
    const r=await api('POST','/api/login',{phone:ph,password:pw,device:devName()},false);
    if(r&&r.token){token=r.token;me=r.user;LS.s('tok',token);LS.s('me',me);enterApp();busy('si-btn','si-lbl',false,'Sign In');return;}
    if(r&&r.error){toast(r.error,'❌');busy('si-btn','si-lbl',false,'Sign In');return;}
  }
  const u=lU(),ud=u[ph];
  if(!ud||ud.pwd!==sh(pw+ph)){toast('Incorrect phone or password','❌');busy('si-btn','si-lbl',false,'Sign In');return;}
  me={id:ud.id,name:ud.name,phone:ud.phone,avatar:ud.avatar,status:ud.status};
  LS.s('me',me);enterApp();busy('si-btn','si-lbl',false,'Sign In');
}

function logout(){
  if(useSrv)api('POST','/api/logout');
  token='';me=null;cts=[];act=null;
  LS.d('tok');LS.d('me');
  if(ws){ws.onclose=null;ws.close();ws=null;}
  wsReady=false;clearTimeout(wsTimer);
  document.getElementById('page-auth').classList.remove('off');
  document.getElementById('app').classList.add('off');
}

async function deleteAccount(){
  if(!confirm('⚠️ Delete your account PERMANENTLY?')) return;
  const pw=prompt('Enter your password to confirm:');
  if(pw===null) return;
  const r=await api('DELETE','/api/account/delete',{password:pw});
  if(r&&r.ok){toast('Account deleted.','🗑️');logout();}
  else toast((r&&r.error)||'Could not delete account','❌');
}

/* ── Enter app ───────────────────────────────────────────────── */
function enterApp(){
  document.getElementById('page-auth').classList.add('off');
  document.getElementById('app').classList.remove('off');
  applyTheme();
  updProf();loadCts();connectWS();loadStories();loadCallHistory();
  if(Notification.permission==='default') Notification.requestPermission();
  if(useSrv) loadPendingRequests();
}

/* ── Nav tabs ────────────────────────────────────────────────── */
function switchNav(tab){
  ['chats','status','calls'].forEach(t=>{
    document.getElementById('nav-'+t).classList.toggle('on',t===tab);
    document.getElementById('panel-'+t).classList.toggle('on',t===tab);
  });
  if(tab==='status') loadStories();
  if(tab==='calls') loadCallHistory();
}

/* ── Profile ─────────────────────────────────────────────────── */
function toggleProfile(){
  profOpen=!profOpen;
  document.getElementById('profile-panel').classList.toggle('hidden',!profOpen);
  if(profOpen){updProf();document.getElementById('ct-panel-section').style.display=act?'block':'none';}
}

function updProf(){
  if(!me) return;
  document.getElementById('sb-av').innerHTML=avatarHtml(me.avatar,36);
  document.getElementById('status-my-av').innerHTML=avatarHtml(me.avatar,44)+'<div class="story-add-plus">+</div>';
  const pAv=document.getElementById('p-av');
  if(me.avatar&&me.avatar!=='👤'&&(me.avatar.startsWith('data:')||me.avatar.startsWith('/')))
    pAv.innerHTML=`<img class="av-img" src="${me.avatar}" alt="DP"/>`;
  else pAv.innerHTML=avatarHtml(me.avatar||'👤',80);
  document.getElementById('p-nm').textContent=me.name||'';
  document.getElementById('p-ph').textContent=me.phone||'';
  document.getElementById('p-st').textContent=me.status||'Hey there! I am using Chat With Co.';
  document.getElementById('pv-nm').textContent=me.name||'';
  document.getElementById('pv-st').textContent=me.status||'';
}

/* ── Contact requests ────────────────────────────────────────── */
async function loadPendingRequests(){
  if(!useSrv) return;
  const r=await api('GET','/api/contact-requests');
  if(Array.isArray(r)){
    pendingReqs=r.map(x=>({request_id:x.id,from_id:x.from_id,from_name:x.from_name,from_phone:x.from_phone,from_avatar:x.from_avatar}));
    updateReqBadge();
  }
}

function updateReqBadge(){
  const btn=document.getElementById('req-btn'),dot=document.getElementById('req-dot');
  if(pendingReqs.length>0){btn.style.display='flex';dot.style.display='block';}
  else{btn.style.display='none';dot.style.display='none';}
}

function openRequests(){renderReqList();document.getElementById('req-modal').classList.remove('off');}
function closeRequests(){document.getElementById('req-modal').classList.add('off');}

function renderReqList(){
  const el=document.getElementById('req-list');
  if(!pendingReqs.length){el.innerHTML=`<div style="text-align:center;color:var(--t3);padding:28px;font-size:13.5px;font-weight:500">No pending requests</div>`;return;}
  el.innerHTML=pendingReqs.map(r=>`
    <div class="req-card" id="req-card-${r.request_id}">
      <div class="req-av">${avatarHtml(r.from_avatar,44)}</div>
      <div style="flex:1">
        <div class="req-name">${esc(r.from_name)}</div>
        <div class="req-phone">${esc(r.from_phone)}</div>
        <div class="req-actions">
          <button class="req-accept" onclick="respondReq(${r.request_id},true)">Accept</button>
          <button class="req-decline" onclick="respondReq(${r.request_id},false)">Decline</button>
        </div>
      </div>
    </div>`).join('');
}

async function respondReq(reqId,accept){
  if(!useSrv){toast('Server required','⚠️');return;}
  const r=await api('POST','/api/contacts/respond',{request_id:reqId,accept});
  if(r&&r.ok){
    pendingReqs=pendingReqs.filter(x=>x.request_id!==reqId);
    updateReqBadge();renderReqList();
    if(accept){toast('Contact added! You can now chat.','✅');await loadCts();}
    else toast('Request declined','👋');
    if(!pendingReqs.length) closeRequests();
  } else toast((r&&r.error)||'Failed','❌');
}

/* ── Contacts ────────────────────────────────────────────────── */
async function loadCts(){
  if(useSrv){
    const r=await api('GET','/api/contacts');
    if(Array.isArray(r)){
      const onlineSet=new Set(cts.filter(c=>c.is_online).map(c=>c._id));
      cts=r.map(c=>({...c,_id:c.contact_id,is_online:onlineSet.has(c.contact_id)?1:c.is_online||0}));
      renderCts(cts);
      if(wsReady)cts.forEach(c=>wsSend({type:'presence_query',user_id:c._id}));
      renderStoriesStrip();
      return;
    }
  }
  const list=lC(me.id),u=lU();
  cts=list.map(c=>{
    const ud=Object.values(u).find(x=>x.id===c.cid);if(!ud)return null;
    const msgs=lM(me.id,c.cid),unread=msgs.filter(x=>x.to===me.id&&!x.rd).length;
    const last=msgs[msgs.length-1];
    return{_id:c.cid,name:ud.name,phone:ud.phone,avatar:ud.avatar||'👤',status:ud.status||'',nickname:c.nick||'',blocked:c.bl||false,unread,is_online:0,last_msg:last?.txt||'',last_msg_ts:last?.ts||0};
  }).filter(Boolean).sort((a,b)=>(b.last_msg_ts||0)-(a.last_msg_ts||0));
  renderCts(cts);
  renderStoriesStrip();
}

function renderCts(list){
  const el=document.getElementById('ct-list');
  if(!list.length){
    el.innerHTML=`<div class="sidebar-empty"><div class="e-ico">💬</div><p>No contacts yet.<br/>Tap ➕ to add someone.</p></div>`;
    return;
  }
  const hidden=getHidden(),muted=getMuted();
  const visible=list.filter(c=>!hidden.includes(c._id));
  if(!visible.length){
    el.innerHTML=`<div class="sidebar-empty"><div class="e-ico">💬</div><p>No contacts yet.<br/>Tap ➕ to add someone.</p></div>`;
    return;
  }
  // Show/hide the hidden chats button
  const hiddenBtn=document.getElementById('hidden-chats-btn');
  const hiddenCount=document.getElementById('hidden-chats-count');
  if(hidden.length>0){
    if(hiddenBtn){hiddenBtn.style.display='flex';}
    if(hiddenCount) hiddenCount.textContent=`${hidden.length} hidden chat${hidden.length>1?'s':''}`;
  } else {
    if(hiddenBtn) hiddenBtn.style.display='none';
    document.getElementById('hidden-chats-list').style.display='none';
  }

  el.innerHTML=visible.map(c=>{
    const isMuted=muted.includes(c._id);
    return`<div class="ct-row${act&&act._id===c._id?' active':''}" onclick="openChat(${c._id})">
      <div class="ct-av" onclick="event.stopPropagation();showContactProfileById(${c._id})">
        ${avatarHtml(c.avatar,48)}
        ${c.is_online?'<div class="online-dot"></div>':''}
      </div>
      <div class="ct-info">
        <div class="ct-top">
          <span class="ct-name">${esc(c.nickname||c.name)}</span>
          <div style="display:flex;align-items:center;gap:4px">
            ${isMuted?'<span style="font-size:13px;opacity:.6">🔕</span>':''}
            <span class="ct-time${c.unread&&!isMuted?' unread':''}">${c.last_msg_ts?frel(c.last_msg_ts):''}</span>
          </div>
        </div>
        <div class="ct-preview">
          <div class="ct-pre-txt">${c.blocked?'<span style="color:var(--red);font-size:11px;font-weight:700">Blocked</span>':esc(c.last_msg||c.status||c.phone)}</div>
          ${c.unread&&!isMuted?`<span class="ct-badge">${c.unread}</span>`:''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function filterC(q){
  const q2=q.toLowerCase();
  renderCts(q2?cts.filter(c=>(c.name||'').toLowerCase().includes(q2)||(c.nickname||'').toLowerCase().includes(q2)||(c.phone||'').includes(q2)):cts);
}

/* ── Open chat ───────────────────────────────────────────────── */
async function openChat(id){
  act=cts.find(c=>c._id===id);if(!act)return;
  document.getElementById('c-av').innerHTML=avatarHtml(act.avatar,40);
  document.getElementById('c-nm').textContent=act.nickname||act.name;
  document.getElementById('c-st').textContent=act.is_online?'online':'last seen recently';
  document.getElementById('dd-block-lbl').textContent=act.blocked?'Unblock':'Block';
  document.getElementById('pp-block-lbl').textContent=act.blocked?'Unblock Contact':'Block Contact';
  document.getElementById('ct-panel-section').style.display='block';
  document.getElementById('chat-welcome').style.display='none';
  document.getElementById('chat-active').style.display='flex';
  closeEmoji();closeFilePicker();
  document.getElementById('sticker-row').style.display='none';
  renderCts(cts);
  await loadMsgs(id,true);
  document.getElementById('ita').focus();
  document.getElementById('sidebar').classList.add('hidden-mobile');
  if(window.innerWidth<=680) document.getElementById('back-btn').style.display='flex';
  wsSend({type:'presence_query',user_id:id});
  // Set mute/hide labels
  const muted=getMuted();
  const muteEl=document.getElementById('dd-mute-lbl');
  if(muteEl) muteEl.textContent=muted.includes(id)?'Unmute':'Mute';
}

function backToList(){
  document.getElementById('sidebar').classList.remove('hidden-mobile');
  document.getElementById('back-btn').style.display='none';
}

/* ── Messages ────────────────────────────────────────────────── */
async function loadMsgs(id,scroll=false){
  let ms;
  if(useSrv){
    const r=await api('GET',`/api/messages?with=${id}&limit=200`);
    if(Array.isArray(r)){
      ms=r.map(m=>({id:m.id,from:m.sender_id,to:m.receiver_id,txt:m.content,tp:m.msg_type||'text',ts:m.sent_at,rd:!!m.read_at,file_url:m.file_url,file_name:m.file_name,file_size:m.file_size,mime:m.mime_type}));
      if(ms.length){const last=ms[ms.length-1];if(last.from!==me.id)wsSend({type:'read_ack',up_to_id:last.id,peer_id:last.from});}
    }
  }
  if(!ms){ms=lM(me.id,id);sM(me.id,id,ms.map(m=>m.to===me.id?{...m,rd:true}:m));}
  renderMsgs(ms,scroll);
  const c=cts.find(x=>x._id===id);if(c){c.unread=0;renderCts(cts);}
}

function fmtSize(b){
  if(!b)return'';if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB';
}
function msgIcon(mime){
  if(!mime)return'📄';if(mime.startsWith('image/'))return'🖼️';if(mime.startsWith('video/'))return'🎬';
  if(mime.startsWith('audio/'))return'🎵';if(mime.includes('pdf'))return'📕';if(mime.includes('word'))return'📝';
  if(mime.includes('excel')||mime.includes('sheet'))return'📊';if(mime.includes('zip'))return'🗜️';return'📄';
}

function bubbleFor(m){
  const mine=m.from===me.id;
  const tick=mine?`<span class="bub-tick${m.rd?' read':''}">${m.rd?'✓✓':'✓'}</span>`:'';
  const foot=`<div class="bub-foot"><span class="bub-time">${ft(m.ts)}</span>${tick}</div>`;
  const tp=m.tp||'text';
  if(tp==='sticker')return`<div class="bubble sticker">${m.txt}</div>`;
  if(tp==='image'){
    const url=m.file_url||m.txt;const safe=url.replace(/'/g,"\\'").replace(/"/g,'&quot;');
    return`<div class="bubble bubble-media"><img src="${url}" loading="lazy" style="max-width:260px;border-radius:10px;cursor:zoom-in" onclick="openLightbox('${safe}')"/>${m.txt&&m.txt!==url?`<div class="media-caption">${esc(m.txt)}</div>`:''} ${foot}</div>`;
  }
  if(tp==='video')return`<div class="bubble bubble-media"><video src="${m.file_url||m.txt}" controls preload="metadata" style="max-width:260px;border-radius:10px;max-height:220px"></video>${foot}</div>`;
  if(tp==='audio')return`<div class="bubble"><div class="audio-msg">🎵<audio src="${m.file_url||m.txt}" controls style="max-width:200px"></audio></div>${foot}</div>`;
  if(tp==='file')return`<div class="bubble"><a href="${m.file_url||m.txt}" target="_blank" class="file-card" download="${esc(m.file_name||'file')}"><span class="file-icon">${msgIcon(m.mime)}</span><div class="file-info"><div class="file-name">${esc(m.file_name||'file')}</div><div class="file-size">${fmtSize(m.file_size)}</div></div>⬇️</a>${foot}</div>`;
  if(tp==='location'){
    const [lat,lng]=m.txt.replace('📍','').trim().split(',');
    return`<div class="bubble"><a href="https://maps.google.com/?q=${lat},${lng}" target="_blank" class="file-card"><span class="file-icon">📍</span><div class="file-info"><div class="file-name">Location</div><div class="file-size">${lat},${lng}</div></div></a>${foot}</div>`;
  }
  return`<div class="bubble">${esc(m.txt)}${foot}</div>`;
}

function renderMsgs(ms,scroll){
  const el=document.getElementById('msgs');
  if(!ms||!ms.length){
    el.innerHTML=`<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--t3);padding:36px;text-align:center"><div style="font-size:56px;opacity:.3;margin-bottom:12px">👋</div><div style="font-size:14px;line-height:1.7;font-weight:500">Send a message to start chatting!</div></div>`;
    return;
  }
  let html='',ld='';
  ms.forEach(m=>{
    const d=fd(m.ts);
    if(d!==ld){html+=`<div class="date-chip"><span>${d}</span></div>`;ld=d;}
    const mine=m.from===me.id;
    html+=`<div class="msg-row ${mine?'out':'in'}" data-id="${m.id||''}" data-cid="${m._cid||''}" data-mine="${mine?1:0}" data-txt="${esc(m.txt||'')}" oncontextmenu="showMsgCtx(event,this,${mine?1:0},${m.id||0},${JSON.stringify(m.txt||'').replace(/</g,'\\u003c')})">
      ${!mine?`<div class="in-avatar" onclick="showContactProfileById(${m.from})">${avatarHtml(act?.avatar,28)}</div>`:''}
      ${bubbleFor(m)}
    </div>`;
  });
  el.innerHTML=html;
  if(scroll) requestAnimationFrame(()=>{el.scrollTop=el.scrollHeight;});
}

function appendMessage(m,scroll){
  const msgs=document.getElementById('msgs');
  if(msgs.querySelector('[style*="flex-direction:column"]'))msgs.innerHTML='';
  const mine=m.from===me.id;
  const div=document.createElement('div');
  div.className='msg-row '+(mine?'out':'in')+(m._cid?' msg-pending':'');
  div.dataset.id=m.id||'';div.dataset.cid=m._cid||'';div.dataset.mine=mine?'1':'0';
  div.setAttribute('oncontextmenu',`showMsgCtx(event,this,${mine?1:0},${m.id||0},${JSON.stringify(m.txt||'').replace(/</g,'\\u003c')})`);
  div.innerHTML=(!mine?`<div class="in-avatar" onclick="showContactProfileById(${m.from})">${avatarHtml(act?.avatar,28)}</div>`:'')+bubbleFor(m);
  msgs.appendChild(div);
  if(scroll)requestAnimationFrame(()=>{msgs.scrollTop=msgs.scrollHeight;});
}

/* ── Message context menu ────────────────────────────────────── */
let ctxHideTimer = null;
function showMsgCtx(e,el,isMine,msgId,txt){
  e.preventDefault();
  closeAllPickers();
  ctxMsgId=msgId;ctxMsgMine=!!isMine;ctxMsgContent=txt;
  const menu=document.getElementById('msg-ctx-menu');
  document.getElementById('ctx-del-everyone').style.display=isMine&&msgId?'flex':'none';
  menu.style.display='block';
  const x=Math.min(e.clientX,window.innerWidth-180);
  const y=Math.min(e.clientY,window.innerHeight-130);
  menu.style.left=x+'px';menu.style.top=y+'px';
  document.addEventListener('click',hideCtxMenu,{once:true});
}
function hideCtxMenu(){document.getElementById('msg-ctx-menu').style.display='none';}
function ctxCopy(){if(ctxMsgContent)navigator.clipboard.writeText(ctxMsgContent).then(()=>toast('Copied','📋'));hideCtxMenu();}
async function ctxDeleteEveryone(){
  hideCtxMenu();
  if(!ctxMsgId){toast('Message not saved yet','⚠️');return;}
  if(!confirm('Delete for everyone?'))return;
  if(useSrv){
    const r=await api('POST','/api/messages/delete_for_everyone',{message_id:ctxMsgId});
    if(r&&r.ok){
      const row=document.querySelector(`[data-id="${ctxMsgId}"]`);
      if(row){const bub=row.querySelector('.bubble');if(bub)bub.innerHTML='<em style="color:var(--t3);font-size:13px">You deleted this message</em>';}
      toast('Deleted for everyone','🗑️');
    } else toast('Failed to delete','❌');
  }
}
async function ctxDeleteForMe(){
  hideCtxMenu();
  if(!confirm('Delete for yourself?'))return;
  if(useSrv&&ctxMsgId){
    await api('POST','/api/messages/delete_for_me',{message_id:ctxMsgId});
  }
  const row=document.querySelector(`[data-id="${ctxMsgId}"]`);
  if(row)row.remove();
  toast('Deleted for you','🗑️');
}

/* ── Send message ────────────────────────────────────────────── */
async function sendMsg(){
  const el=document.getElementById('ita'),t=el.value.trim();
  if(!act)return;
  if(pendingFile){await sendFileMsg(t);return;}
  if(!t)return;
  el.value='';el.style.height='';
  const clientId='c'+(++_cseq),now=Math.floor(Date.now()/1000);
  appendMessage({id:0,_cid:clientId,from:me.id,to:act._id,txt:t,tp:'text',ts:now,rd:false},true);
  const payload={receiver_id:act._id,content:t,msg_type:'text'};
  if(useSrv&&wsReady){try{await wsSendMsg(payload,clientId);return;}catch(e){}}
  if(useSrv){const r=await api('POST','/api/send',payload);if(r&&!r.error){replaceOptimistic(clientId,r);return;}if(r&&r.error)toast(r.error,'❌');return;}
  const ms=lM(me.id,act._id);ms.push({id:seq(),from:me.id,to:act._id,txt:t,tp:'text',ts:now,rd:false});sM(me.id,act._id,ms);
}

async function sendStk(e){
  if(!act)return;document.getElementById('sticker-row').style.display='none';
  const clientId='c'+(++_cseq),now=Math.floor(Date.now()/1000);
  appendMessage({id:0,_cid:clientId,from:me.id,to:act._id,txt:e,tp:'sticker',ts:now,rd:false},true);
  const payload={receiver_id:act._id,content:e,msg_type:'sticker'};
  if(useSrv&&wsReady){try{await wsSendMsg(payload,clientId);return;}catch{}}
  if(useSrv){const r=await api('POST','/api/send',payload);if(r&&!r.error){replaceOptimistic(clientId,r);return;}}
  const ms=lM(me.id,act._id);ms.push({id:seq(),from:me.id,to:act._id,txt:e,tp:'sticker',ts:now,rd:false});sM(me.id,act._id,ms);
}

/* ── File type picker ────────────────────────────────────────── */
const MIME_FILTERS = {
  photo:'image/*',video:'video/*',audio:'audio/*',
  document:'.pdf,.doc,.docx,.xls,.xlsx,.txt',
  file:'*',location:null
};
function toggleFilePicker(){
  const fp=document.getElementById('file-type-picker');
  const isOpen=fp.style.display==='grid';
  closeAllPickers();
  if(!isOpen){fp.style.display='grid';closeEmoji();}
}
function closeFilePicker(){document.getElementById('file-type-picker').style.display='none';}
function pickFileType(type){
  closeFilePicker();
  if(type==='location'){sendLocation();return;}
  const fi=document.getElementById('file-input');
  fi.accept=MIME_FILTERS[type]||'*';
  currentFileMimeFilter=type;
  fi.click();
}
async function sendLocation(){
  if(!act)return;
  if(!navigator.geolocation){toast('Geolocation not supported','❌');return;}
  navigator.geolocation.getCurrentPosition(async pos=>{
    const {latitude:lat,longitude:lng}=pos.coords;
    const t=`📍 ${lat.toFixed(5)},${lng.toFixed(5)}`;
    const clientId='c'+(++_cseq),now=Math.floor(Date.now()/1000);
    appendMessage({id:0,_cid:clientId,from:me.id,to:act._id,txt:t,tp:'location',ts:now,rd:false},true);
    const payload={receiver_id:act._id,content:t,msg_type:'location'};
    if(useSrv&&wsReady){try{await wsSendMsg(payload,clientId);return;}catch{}}
    if(useSrv){const r=await api('POST','/api/send',payload);if(r&&!r.error){replaceOptimistic(clientId,r);return;}}
  },()=>toast('Could not get location','❌'));
}

function onFileSelected(input){
  const file=input.files[0];if(!file)return;
  const mime=file.type||'application/octet-stream';
  pendingFile={file,localUrl:URL.createObjectURL(file),mime,name:file.name,size:file.size};
  const bar=document.getElementById('attach-bar'),icon=document.getElementById('ab-icon');
  document.getElementById('ab-name').textContent=file.name;
  document.getElementById('ab-size').textContent=fmtSize(file.size);
  if(mime.startsWith('image/'))icon.innerHTML=`<img class="ab-thumb" src="${pendingFile.localUrl}" style="height:50px;border-radius:8px;object-fit:cover"/>`;
  else if(mime.startsWith('video/'))icon.innerHTML=`<span style="font-size:28px">🎬</span>`;
  else icon.innerHTML=`<span style="font-size:28px">${msgIcon(mime)}</span>`;
  bar.classList.remove('off');
  input.value='';
}

function clearAttach(){pendingFile=null;document.getElementById('attach-bar').classList.add('off');}

async function sendFileMsg(caption=''){
  if(!pendingFile||!act)return;
  const{file,localUrl,mime,name,size}=pendingFile;
  document.getElementById('ita').value='';clearAttach();
  const tp=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'file';
  const clientId='c'+(++_cseq),now=Math.floor(Date.now()/1000);
  appendMessage({id:0,_cid:clientId,from:me.id,to:act._id,txt:caption||name,tp,ts:now,rd:false,file_url:localUrl,file_name:name,file_size:size,mime},true);
  if(useSrv){
    const uploadResult=await uploadWithProgress(file,name);
    if(!uploadResult){toast('Upload failed — check file size/type','❌');return;}
    const extras={file_url:uploadResult.url,file_name:uploadResult.filename,file_size:uploadResult.size,mime_type:uploadResult.mime};
    const payload={receiver_id:act._id,content:caption||name,msg_type:tp,...extras};
    if(wsReady){try{await wsSendMsg(payload,clientId);return;}catch{}}
    const r=await api('POST','/api/send',payload);
    if(r&&!r.error){replaceOptimistic(clientId,r);return;}
    if(r&&r.error)toast(r.error,'❌');
    return;
  }
  const ms=lM(me.id,act._id);
  ms.push({id:seq(),from:me.id,to:act._id,txt:caption||name,tp,file_url:localUrl,file_name:name,file_size:size,mime,ts:now,rd:false});
  sM(me.id,act._id,ms);
}

function uploadWithProgress(file,name){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest(),fd=new FormData();
    fd.append('file',file,name);
    xhr.open('POST',SRV+'/api/upload');
    xhr.setRequestHeader('Authorization','Bearer '+token);
    xhr.upload.onprogress=e=>{if(e.lengthComputable)setUploadProgress(Math.round(e.loaded/e.total*90));};
    xhr.onload=()=>{setUploadProgress(100);try{const j=JSON.parse(xhr.responseText);if(j.ok)resolve(j);else reject(j.error||'Upload failed');}catch{reject('Parse error');}};
    xhr.onerror=()=>reject('Network error');
    xhr.send(fd);
  });
}

/* ── DP upload ───────────────────────────────────────────────── */
function triggerDPUpload(){document.getElementById('dp-input').click();}
async function onDPSelected(input){
  const file=input.files[0];if(!file)return;
  if(!file.type.startsWith('image/')){toast('Select an image file','❌');input.value='';return;}
  if(file.size>5*1024*1024){toast('Image must be < 5MB','❌');input.value='';return;}
  const localUrl=URL.createObjectURL(file);
  document.getElementById('p-av').innerHTML=`<img class="av-img" src="${localUrl}" alt="DP"/>`;
  document.getElementById('sb-av').innerHTML=avatarHtml(localUrl,36);
  input.value='';
  if(useSrv){
    const fd=new FormData();fd.append('file',file,'avatar'+file.name.match(/\.\w+$/)?.[0]||'.jpg');
    try{
      const resp=await fetch(SRV+'/api/avatar/upload',{method:'POST',headers:{'Authorization':'Bearer '+token},body:fd});
      const j=await resp.json();
      if(j.ok){me.avatar=j.avatar;LS.s('me',me);toast('Profile photo updated!','✅');updProf();return;}
      toast(j.error||'Upload failed','❌');
    }catch{toast('Upload error','❌');}
    return;
  }
  const reader=new FileReader();
  reader.onload=e=>{me.avatar=e.target.result;LS.s('me',me);const u=lU();if(u[me.phone]){u[me.phone].avatar=me.avatar;sU(u);}toast('Profile photo updated!','✅');updProf();};
  reader.readAsDataURL(file);
}

/* ── Lightbox ────────────────────────────────────────────────── */
function openLightbox(url){document.getElementById('lightbox-img').src=url;document.getElementById('lightbox').classList.remove('off');}
function closeLightbox(){document.getElementById('lightbox').classList.add('off');setTimeout(()=>{document.getElementById('lightbox-img').src='';},250);}

/* ── Typing indicator ────────────────────────────────────────── */
let _tyOut=null,_tyInEl=null,_tyInTimer=null;
function sendTyping(){if(!act||!wsReady)return;clearTimeout(_tyOut);wsSend({type:'typing',to:act._id});_tyOut=setTimeout(()=>{_tyOut=null;},2500);}
function showTypingBubble(){
  const msgs=document.getElementById('msgs');clearTimeout(_tyInTimer);
  if(!_tyInEl){_tyInEl=document.createElement('div');_tyInEl.id='typing-ind';_tyInEl.className='msg-row in';_tyInEl.innerHTML=`<div class="in-avatar">${avatarHtml(act?.avatar,28)}</div><div class="typing-bubble"><span></span><span></span><span></span></div>`;msgs.appendChild(_tyInEl);msgs.scrollTop=msgs.scrollHeight;}
  _tyInTimer=setTimeout(()=>{if(_tyInEl){_tyInEl.remove();_tyInEl=null;}},3000);
}

/* ── Contact profile ─────────────────────────────────────────── */
function openContactProfile(){if(act)showContactProfileById(act._id);}
async function showContactProfileById(userId){
  const c=cts.find(x=>x._id===userId);if(!c&&!userId)return;
  let profile=c||{};
  if(useSrv){const r=await api('GET',`/api/contact/profile?user_id=${userId}`);if(r&&!r.error)profile={...c,...r};}
  // Load shared media from messages
  let mediaList=[];
  if(useSrv){
    const msgs=await api('GET',`/api/messages?with=${userId}&limit=300`);
    if(Array.isArray(msgs)){mediaList=msgs.filter(m=>m.msg_type==='image'&&m.file_url).slice(0,9);}
  }
  const isOnline=profile.is_online;
  const lastSeen=profile.last_seen;
  // Categorise shared files
  let allMsgsData=[];
  if(useSrv){const r2=await api('GET',`/api/messages?with=${userId}&limit=500`);if(Array.isArray(r2))allMsgsData=r2;}
  else{allMsgsData=lM(me.id,userId).map(m=>({msg_type:m.tp,file_url:m.file_url||m.txt,file_name:m.file_name||'',mime_type:m.mime||''}));}

  const sharedPhotos=allMsgsData.filter(m=>m.msg_type==='image'&&m.file_url);
  const sharedVideos=allMsgsData.filter(m=>m.msg_type==='video'&&m.file_url);
  const sharedDocs=allMsgsData.filter(m=>m.msg_type==='file'&&m.file_url);
  const sharedLinks=allMsgsData.filter(m=>m.msg_type==='text'&&m.content&&/(https?:\/\/[^\s]+)/g.test(m.content));
  const totalMedia=sharedPhotos.length+sharedVideos.length+sharedDocs.length;

  document.getElementById('cpm-content').innerHTML=`
    <div class="cpm-cover">
      <div class="cpm-av">${avatarHtml(profile.avatar||'👤',76)}</div>
      <div class="cpm-name">${esc(profile.nickname||profile.name||'Unknown')}</div>
      <div class="cpm-phone">${esc(profile.phone||'')}</div>
      <div class="cpm-status">${esc(profile.status||'Hey there!')}</div>
      <div class="cpm-actions">
        <button class="cpm-action-btn" onclick="closeContactProfile();openChat(${userId})"><span>💬</span><span>Message</span></button>
        <button class="cpm-action-btn" onclick="closeContactProfile();startCall('audio')"><span>📞</span><span>Call</span></button>
        <button class="cpm-action-btn" onclick="closeContactProfile();startCall('video')"><span>🎬</span><span>Video</span></button>
      </div>
    </div>

    <div class="cpm-info-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <div><div class="cpm-info-text">${isOnline?'<span style="color:#25d366;font-weight:700">● Online</span>':`Last seen ${lastSeen?new Date(lastSeen*1000).toLocaleString():'recently'}`}</div></div>
    </div>
    <div class="cpm-info-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <div style="flex:1"><div class="cpm-info-text">${esc(profile.status||'Hey there! I am using Chat With Co.')}</div><div class="cpm-info-sub">About</div></div>
    </div>
    <div class="cpm-info-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 9.8a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      <div><div class="cpm-info-text">${esc(profile.phone||'')}</div><div class="cpm-info-sub">Phone</div></div>
    </div>

    <!-- Media, links and docs row -->
    <div class="cpm-media-links-row" onclick="cpmShowTab('media')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      <div style="flex:1"><div class="cpm-info-text">Media, links and docs</div></div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:14px;font-weight:700;color:var(--t3)">${totalMedia+sharedLinks.length}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:15px;height:15px;color:var(--t3)"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </div>

    <!-- Tab buttons -->
    <div class="cpm-tabs" id="cpm-tabs">
      <button class="cpm-tab on" id="cpm-tab-media" onclick="cpmShowTab('media')">Media</button>
      <button class="cpm-tab" id="cpm-tab-docs" onclick="cpmShowTab('docs')">Docs</button>
      <button class="cpm-tab" id="cpm-tab-links" onclick="cpmShowTab('links')">Links</button>
    </div>

    <!-- Tab content -->
    <div id="cpm-tab-content-media" class="cpm-tab-content">
      ${sharedPhotos.length||sharedVideos.length?`
        <div class="cpm-media-grid">
          ${sharedPhotos.slice(0,9).map(m=>`<div class="cpm-media-thumb" onclick="openLightbox('${m.file_url}')"><img src="${m.file_url}" loading="lazy"/></div>`).join('')}
          ${sharedVideos.slice(0,3).map(m=>`<div class="cpm-media-thumb"><video src="${m.file_url}" style="width:100%;height:100%;object-fit:cover"></video></div>`).join('')}
        </div>
        ${sharedPhotos.length>9?`<div style="text-align:center;padding:8px 0 6px;font-size:13px;font-weight:600;color:var(--ac2);cursor:pointer">View all ${sharedPhotos.length} photos</div>`:''}`
      :`<div style="text-align:center;padding:24px;color:var(--t3);font-weight:500;font-size:13px">No shared photos or videos</div>`}
    </div>
    <div id="cpm-tab-content-docs" class="cpm-tab-content" style="display:none">
      ${sharedDocs.length?sharedDocs.map(m=>`<a href="${m.file_url}" target="_blank" class="cpm-doc-row">
        <span style="font-size:26px">${msgIcon(m.mime_type)}</span>
        <div><div class="cpm-info-text" style="font-size:13px">${esc(m.file_name||'Document')}</div></div>
      </a>`).join('')
      :`<div style="text-align:center;padding:24px;color:var(--t3);font-weight:500;font-size:13px">No shared documents</div>`}
    </div>
    <div id="cpm-tab-content-links" class="cpm-tab-content" style="display:none">
      ${sharedLinks.length?sharedLinks.map(m=>{
        const urls=(m.content||'').match(/(https?:\/\/[^\s]+)/g)||[];
        return urls.map(url=>`<a href="${esc(url)}" target="_blank" class="cpm-doc-row">
          <span style="font-size:22px">🔗</span>
          <div><div class="cpm-info-text" style="font-size:12.5px;word-break:break-all">${esc(url)}</div></div>
        </a>`).join('');
      }).join('')
      :`<div style="text-align:center;padding:24px;color:var(--t3);font-weight:500;font-size:13px">No shared links</div>`}
    </div>

    <div style="height:16px"></div>
  `;
  document.getElementById('contact-profile-modal').classList.remove('off');
}
function cpmShowTab(tab){
  ['media','docs','links'].forEach(t=>{
    const btn=document.getElementById('cpm-tab-'+t);
    const panel=document.getElementById('cpm-tab-content-'+t);
    if(btn) btn.classList.toggle('on',t===tab);
    if(panel) panel.style.display=t===tab?'block':'none';
  });
}
function closeContactProfile(){document.getElementById('contact-profile-modal').classList.add('off');}

/* ── Stories ─────────────────────────────────────────────────── */
let allStories = [];
async function loadStories(){
  let srvStories=[];
  if(useSrv){
    const r=await api('GET','/api/stories');
    if(Array.isArray(r)) srvStories=r;
  }
  // Merge in local stories (offline mode or own stories before server confirms)
  const now=Math.floor(Date.now()/1000);
  const local=lStories().filter(s=>s.expires_at>now&&s.user_id===me?.id);
  // Deduplicate: local ones only added if not already in srvStories for same user+content
  const merged=[...srvStories];
  local.forEach(ls=>{
    if(!merged.find(s=>s.user_id===ls.user_id&&s.content===ls.content&&Math.abs(s.created_at-ls.created_at)<5))
      merged.push(ls);
  });
  allStories=merged;
  renderStoriesTab();renderStoriesStrip();
}

function renderStoriesStrip(){
  const strip=document.getElementById('stories-strip-chats');
  const byUser={};
  allStories.forEach(s=>{if(!byUser[s.user_id])byUser[s.user_id]=[];byUser[s.user_id].push(s);});
  const myStories=byUser[me?.id]||[];
  let html=`<div class="story-strip-item" onclick="openAddStory()">
    <div class="story-strip-ring mine">
      <div class="story-strip-inner">${avatarHtml(me?.avatar,44)}</div>
    </div>
    <div class="story-strip-name">My Status</div>
  </div>`;
  Object.entries(byUser).forEach(([uid,stories])=>{
    if(parseInt(uid)===me?.id)return;
    const u=cts.find(c=>c._id===parseInt(uid));if(!u)return;
    const allSeen=stories.every(s=>s.i_viewed>0);
    html+=`<div class="story-strip-item" onclick="viewStories(${uid})">
      <div class="story-strip-ring${allSeen?' seen':''}">
        <div class="story-strip-inner">${avatarHtml(u.avatar,44)}</div>
      </div>
      <div class="story-strip-name">${esc(u.name)}</div>
    </div>`;
  });
  strip.innerHTML=html;
}

function renderStoriesTab(){
  // ── My own stories ───────────────────────────────────────────────
  const myEl=document.getElementById('my-stories-list');
  const myStories=allStories.filter(s=>s.user_id===me?.id);
  const myRow=document.getElementById('my-status-row');
  const myTitle=document.getElementById('my-status-title');
  const mySub=document.getElementById('my-status-sub');
  if(myStories.length){
    // Show ring avatar with live status — clickable to view
    if(myRow) myRow.onclick=()=>viewMyStories();
    if(myTitle) myTitle.textContent='My Status';
    if(mySub) mySub.textContent=`${myStories.length} update${myStories.length>1?'s':''} · ${frel(myStories[0].created_at)}`;
    // Show individual story previews below
    myEl.innerHTML=myStories.map((s,i)=>`
      <div class="my-story-item" onclick="viewMyStoryAt(${i})">
        <div class="my-story-thumb">${s.story_type==='image'&&s.file_url?`<img src="${s.file_url}" style="width:100%;height:100%;object-fit:cover;border-radius:8px"/>`:
          s.story_type==='video'&&s.file_url?`<video src="${s.file_url}" style="width:100%;height:100%;object-fit:cover;border-radius:8px" muted></video>`:
          `<div style="width:100%;height:100%;border-radius:8px;background:linear-gradient(135deg,#075e54,#128c7e);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;text-align:center;padding:3px;word-break:break-all">${esc((s.content||'').slice(0,20))}</div>`}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.content||'Status')}</div>
          <div style="font-size:11px;color:var(--t3);margin-top:1px;display:flex;align-items:center;gap:5px">
            ${frel(s.created_at)} · 👁️ ${s.view_count||0}
          </div>
        </div>
        <button onclick="event.stopPropagation();deleteMyStory(${s.id})" style="border:none;background:none;cursor:pointer;color:var(--t3);font-size:18px;padding:4px;flex-shrink:0" title="Delete">🗑️</button>
      </div>`).join('');
    // Update avatar ring to show "has status"
    const avWrap=document.getElementById('status-my-av');
    if(avWrap){avWrap.style.background='conic-gradient(#25d366,#128c7e)';avWrap.style.padding='3px';}
    const plus=document.getElementById('my-status-plus');if(plus)plus.textContent='+';
  } else {
    myEl.innerHTML='';
    if(myRow) myRow.onclick=()=>openAddStory();
    if(myTitle) myTitle.textContent='My Status';
    if(mySub) mySub.textContent='Tap to add a status update';
    const avWrap=document.getElementById('status-my-av');
    if(avWrap){avWrap.style.background='';avWrap.style.padding='';}
  }

  // ── Contacts' stories ────────────────────────────────────────────
  const el=document.getElementById('status-list');
  const byUser={};
  allStories.forEach(s=>{if(s.user_id!==me?.id){if(!byUser[s.user_id])byUser[s.user_id]=[];byUser[s.user_id].push(s);}});
  if(!Object.keys(byUser).length){
    el.innerHTML=`<div style="text-align:center;padding:24px;color:var(--t3);font-size:13px;font-weight:500">No recent updates from contacts</div>`;
    return;
  }
  el.innerHTML=Object.entries(byUser).map(([uid,stories])=>{
    const u=cts.find(c=>c._id===parseInt(uid));if(!u)return'';
    const allSeen=stories.every(s=>s.i_viewed>0);
    const latest=stories[0];
    return`<div class="story-user-row" onclick="viewStories(${uid})">
      <div class="story-ring-av${allSeen?' seen':''}">
        <div class="story-ring-inner">${avatarHtml(u.avatar,44)}</div>
      </div>
      <div class="story-user-info">
        <div class="story-user-name">${esc(u.name)}</div>
        <div class="story-user-time">${frel(latest.created_at)} · ${stories.length} update${stories.length>1?'s':''}</div>
      </div>
    </div>`;
  }).join('');
}

function viewMyStories(){
  const myStories=allStories.filter(s=>s.user_id===me?.id);
  if(!myStories.length){openAddStory();return;}
  openStoryViewer([{user:{name:me.name,avatar:me.avatar},stories:myStories}],0,0);
}
function viewMyStoryAt(idx){
  const myStories=allStories.filter(s=>s.user_id===me?.id);
  if(!myStories.length)return;
  openStoryViewer([{user:{name:me.name,avatar:me.avatar},stories:myStories}],0,idx);
}
async function deleteMyStory(storyId){
  if(!confirm('Delete this status?'))return;
  if(useSrv) await api('POST','/api/story/delete',{story_id:storyId});
  // Also remove from local
  const arr=lStories().filter(s=>s.id!==storyId);sStories(arr);
  toast('Status deleted','🗑️');loadStories();
}

function viewStories(userId){
  const byUser={};
  allStories.forEach(s=>{if(!byUser[s.user_id])byUser[s.user_id]=[];byUser[s.user_id].push(s);});
  const userStories=byUser[userId];if(!userStories||!userStories.length)return;
  const user=cts.find(c=>c._id===parseInt(userId))||{name:'Unknown',avatar:'👤'};
  openStoryViewer([{user,stories:userStories}],0,0);
}

function openStoryViewer(groups,groupIdx,storyIdx){
  storyGroups=groups;currentStoryGroupIdx=groupIdx;currentStoryIdx=storyIdx;
  document.getElementById('story-viewer').classList.remove('off');
  renderCurrentStory();
}

function renderCurrentStory(){
  clearTimeout(storyTimer);
  const group=storyGroups[currentStoryGroupIdx];if(!group)return;
  const story=group.stories[currentStoryIdx];if(!story)return;
  const user=group.user;
  document.getElementById('sv-user-av').innerHTML=avatarHtml(user.avatar,34);
  document.getElementById('sv-user-name').textContent=user.name;
  document.getElementById('sv-user-time').textContent=frel(story.created_at);
  // Progress bars
  const bars=group.stories.map((s,i)=>`<div class="sv-prog-bar"><div class="sv-prog-fill" id="sv-fill-${i}" style="width:${i<currentStoryIdx?'100':i===currentStoryIdx?'0':'0'}%"></div></div>`).join('');
  document.getElementById('sv-progress-bars').innerHTML=bars;
  // Content
  const content=document.getElementById('sv-content');
  if(story.story_type==='image'&&story.file_url){
    content.innerHTML=`<img src="${story.file_url}" style="max-width:100%;max-height:100%;object-fit:contain"/>`;
  } else if(story.story_type==='video'&&story.file_url){
    content.innerHTML=`<video src="${story.file_url}" autoplay controls style="max-width:100%;max-height:100%"></video>`;
  } else {
    const colors=['#075e54','#128c7e','#1877f2','#7b2ff7','#e91e8c'];
    const bg=colors[story.id%colors.length];
    content.innerHTML=`<div style="background:${bg};width:100%;height:100%;display:flex;align-items:center;justify-content:center"><div class="sv-text-story">${esc(story.content)}</div></div>`;
  }
  // Viewers count (only for own stories)
  const isOwn=story.user_id===me?.id;
  document.getElementById('sv-viewers-count').innerHTML=isOwn?`<span onclick="showStoryViewers(${story.id})" style="cursor:pointer">👁️ ${story.view_count||0} viewer${(story.view_count||0)!==1?'s':''} · Tap to see</span>`:'';
  // Mark as viewed
  if(!isOwn&&useSrv)api('POST','/api/story/view',{story_id:story.id});
  // Animate progress bar
  const fill=document.getElementById(`sv-fill-${currentStoryIdx}`);
  const duration=story.story_type==='text'?5000:10000;
  if(fill){
    fill.style.transition=`width ${duration}ms linear`;
    requestAnimationFrame(()=>fill.style.width='100%');
  }
  storyTimer=setTimeout(storyNavNext,duration);
}

function storyNavNext(){
  clearTimeout(storyTimer);
  const group=storyGroups[currentStoryGroupIdx];
  if(currentStoryIdx<group.stories.length-1){currentStoryIdx++;renderCurrentStory();}
  else if(currentStoryGroupIdx<storyGroups.length-1){currentStoryGroupIdx++;currentStoryIdx=0;renderCurrentStory();}
  else closeStoryViewer();
}

function storyNavPrev(){
  clearTimeout(storyTimer);
  if(currentStoryIdx>0){currentStoryIdx--;renderCurrentStory();}
  else if(currentStoryGroupIdx>0){currentStoryGroupIdx--;const g=storyGroups[currentStoryGroupIdx];currentStoryIdx=g.stories.length-1;renderCurrentStory();}
}

function closeStoryViewer(){
  clearTimeout(storyTimer);document.getElementById('story-viewer').classList.add('off');
}

async function showStoryViewers(storyId){
  if(!useSrv)return;
  const r=await api('GET',`/api/story/viewers?story_id=${storyId}`);
  const el=document.getElementById('viewers-list');
  if(Array.isArray(r)&&r.length){
    el.innerHTML=r.map(v=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd)">
      <div style="width:40px;height:40px;border-radius:50%;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:20px;overflow:hidden">${avatarHtml(v.avatar,38)}</div>
      <div><div style="font-size:14px;font-weight:700">${esc(v.name)}</div><div style="font-size:12px;color:var(--t3)">${new Date(v.viewed_at*1000).toLocaleString()}</div></div>
    </div>`).join('');
  } else {
    el.innerHTML=`<div style="text-align:center;color:var(--t3);padding:20px;font-weight:500">No views yet</div>`;
  }
  document.getElementById('viewers-modal').classList.remove('off');
}

/* ── Add Story ───────────────────────────────────────────────── */
function openAddStory(){
  currentStoryType='text';
  document.getElementById('story-text').value='';
  document.getElementById('story-caption').value='';
  document.getElementById('story-preview').innerHTML='<span style="color:var(--t3);font-size:14px;font-weight:500">Tap to choose file</span>';
  pendingStoryFile=null;
  setStoryType('text');
  document.getElementById('story-modal').classList.remove('off');
}
function closeAddStory(){document.getElementById('story-modal').classList.add('off');}

function setStoryType(type){
  currentStoryType=type;
  ['text','image','video'].forEach(t=>{document.getElementById('stype-'+t).classList.toggle('on',t===type);});
  document.getElementById('story-text-area').style.display=type==='text'?'block':'none';
  document.getElementById('story-file-area').style.display=type!=='text'?'block':'none';
  if(type==='image')document.getElementById('story-file-input').accept='image/*';
  if(type==='video')document.getElementById('story-file-input').accept='video/*';
}

function onStoryFileSelected(input){
  const file=input.files[0];if(!file)return;
  pendingStoryFile=file;
  const url=URL.createObjectURL(file);
  const preview=document.getElementById('story-preview');
  if(file.type.startsWith('image/')){preview.innerHTML=`<img src="${url}" style="max-width:100%;max-height:200px;border-radius:10px;object-fit:contain"/>`;}
  else{preview.innerHTML=`<video src="${url}" style="max-width:100%;max-height:200px;border-radius:10px" muted></video>`;}
  input.value='';
}

/* ── Local story storage (offline fallback) ─ */
function lStories(){return LS.g('local_stories')||[];}
function sStories(arr){LS.s('local_stories',arr);}
function localPostStory(story){
  const arr=lStories(),now=Math.floor(Date.now()/1000);
  arr.unshift({id:now,user_id:me.id,name:me.name,avatar:me.avatar||'👤',
    content:story.content,story_type:story.story_type||'text',
    file_url:story.file_url||null,mime_type:story.mime_type||null,
    created_at:now,expires_at:now+86400,view_count:0,i_viewed:0});
  sStories(arr.filter(s=>s.expires_at>now));
}

async function postStory(){
  if(currentStoryType==='text'){
    const content=document.getElementById('story-text').value.trim();
    if(!content){toast('Write something first','⚠️');return;}
    if(useSrv){
      const r=await api('POST','/api/story/post',{content,story_type:'text'});
      if(r&&r.ok){toast('Status posted!','✅');closeAddStory();loadStories();return;}
    }
    // Offline fallback: save to localStorage
    localPostStory({content,story_type:'text'});
    toast('Status posted!','✅');closeAddStory();loadStories();
  } else {
    if(!pendingStoryFile){toast('Choose a file first','⚠️');return;}
    const caption=document.getElementById('story-caption').value.trim();
    if(useSrv){
      const uploadResult=await uploadWithProgress(pendingStoryFile,pendingStoryFile.name);
      if(uploadResult){
        const r=await api('POST','/api/story/post',{content:caption||pendingStoryFile.name,story_type:currentStoryType,file_url:uploadResult.url,mime_type:uploadResult.mime});
        if(r&&r.ok){toast('Status posted!','✅');closeAddStory();loadStories();return;}
      }
    }
    // Offline fallback: use object URL (ephemeral but works this session)
    const localUrl=URL.createObjectURL(pendingStoryFile);
    localPostStory({content:caption||pendingStoryFile.name,story_type:currentStoryType,file_url:localUrl,mime_type:pendingStoryFile.type});
    toast('Status posted (local)!','✅');closeAddStory();loadStories();
  }
}

/* ── Call history ────────────────────────────────────────────── */
async function loadCallHistory(){
  const el=document.getElementById('call-list');
  if(!useSrv){el.innerHTML=`<div class="sidebar-empty"><div class="e-ico">📞</div><p>Call history requires server connection.</p></div>`;return;}
  const r=await api('GET','/api/calls');
  if(!Array.isArray(r)||!r.length){el.innerHTML=`<div class="sidebar-empty"><div class="e-ico">📞</div><p>No calls yet.</p></div>`;return;}
  el.innerHTML=r.map(call=>{
    const isOutgoing=call.caller_id===me?.id;
    const otherName=isOutgoing?call.callee_name:call.caller_name;
    const otherAv=isOutgoing?call.callee_avatar:call.caller_avatar;
    const otherId=isOutgoing?call.callee_id:call.caller_id;
    const missed=call.status==='missed'||call.status==='rejected';
    const dur=call.duration_s>0?`${Math.floor(call.duration_s/60)}:${(call.duration_s%60).toString().padStart(2,'0')}`:'';
    const icon=call.call_type==='video'?'📹':'📞';
    const dirIcon=isOutgoing?'↗':'↙';
    return`<div class="call-row">
      <div class="call-av">${avatarHtml(otherAv,50)}</div>
      <div class="call-info">
        <div class="call-name">${esc(otherName||'Unknown')}</div>
        <div class="call-meta${missed?' missed':''}">
          ${icon} ${dirIcon} ${isOutgoing?'Outgoing':'Incoming'} ${call.call_type} call
          ${dur?`· ${dur}`:''}
          · ${frel(call.started_at)}
        </div>
      </div>
      <button class="call-action" onclick="callContact(${otherId},'${call.call_type}')" title="Call back">${icon}</button>
    </div>`;
  }).join('');
}

async function callContact(userId,type){
  const c=cts.find(x=>x._id===userId);
  if(!c){toast('Contact not found','❌');return;}
  act=c;
  document.getElementById('c-nm').textContent=c.name;
  document.getElementById('chat-welcome').style.display='none';
  document.getElementById('chat-active').style.display='flex';
  startCall(type);
}

/* ── Dropdown ────────────────────────────────────────────────── */
function toggleDD(){const m=document.getElementById('dd-menu'),o=document.getElementById('dd-overlay');const open=m.style.display==='block';m.style.display=open?'none':'block';o.style.display=open?'none':'block';}
function closeDD(){document.getElementById('dd-menu').style.display='none';document.getElementById('dd-overlay').style.display='none';}
/* muted / hidden chat sets stored locally */
function getMuted(){return LS.g('muted_chats')||[];}
function getHidden(){return LS.g('hidden_chats')||[];}

function ddAct(a){
  closeDD();
  if(a==='profile'){openContactProfile();return;}
  if(a==='theme'){openTheme();return;}
  if(a==='mute'){
    if(!act)return;
    const muted=getMuted();const idx=muted.indexOf(act._id);
    const nowMuted=idx===-1;
    if(nowMuted)muted.push(act._id);else muted.splice(idx,1);
    LS.s('muted_chats',muted);
    act.muted=nowMuted;
    document.getElementById('dd-mute-lbl').textContent=nowMuted?'Unmute':'Mute';
    toast(nowMuted?'Chat muted':'Chat unmuted',nowMuted?'🔕':'🔔');
    return;
  }
  if(a==='hide'){
    if(!act)return;
    const hidden=getHidden();const idx=hidden.indexOf(act._id);
    const nowHidden=idx===-1;
    if(nowHidden)hidden.push(act._id);else hidden.splice(idx,1);
    LS.s('hidden_chats',hidden);
    if(nowHidden){
      act=null;
      document.getElementById('chat-welcome').style.display='flex';
      document.getElementById('chat-active').style.display='none';
      document.getElementById('sidebar').classList.remove('hidden-mobile');
    }
    toast(nowHidden?'Chat hidden (tap avatar to show all)':'Chat unhidden',nowHidden?'👁️‍🗨️':'👁️');
    loadCts();return;
  }
  if(a==='clear'){if(!act||!confirm('Clear all messages?'))return;if(useSrv)api('POST','/api/messages/clear',{contact_id:act._id});else sM(me.id,act._id,[]);renderMsgs([],false);toast('Chat cleared','🗑️');return;}
  if(a==='block'){const nb=!act.blocked;if(useSrv)api('POST','/api/contacts/block',{contact_id:act._id,blocked:nb?1:0});else{const l=lC(me.id),c=l.find(x=>x.cid===act._id);if(c){c.bl=nb;sC(me.id,l);}}act.blocked=nb;document.getElementById('c-st').textContent=nb?'Blocked':'online';document.getElementById('dd-block-lbl').textContent=nb?'Unblock':'Block';document.getElementById('pp-block-lbl').textContent=nb?'Unblock Contact':'Block Contact';toast(nb?'Blocked':'Unblocked',nb?'🚫':'✅');loadCts();}
}

/* ── Hidden chats panel ─────────────────────────────────────── */
let hiddenOpen = false;
function toggleHiddenChats(){
  hiddenOpen=!hiddenOpen;
  const list=document.getElementById('hidden-chats-list');
  const chev=document.getElementById('hidden-chats-chev');
  list.style.display=hiddenOpen?'block':'none';
  if(chev) chev.style.transform=hiddenOpen?'rotate(90deg)':'rotate(0deg)';
  if(hiddenOpen) renderHiddenList();
}
function renderHiddenList(){
  const hidden=getHidden();
  const el=document.getElementById('hidden-chats-list');
  const hiddenCts=cts.filter(c=>hidden.includes(c._id));
  if(!hiddenCts.length){el.innerHTML=`<div style="padding:14px 16px;font-size:13px;color:var(--t3);font-weight:500">No hidden chats</div>`;return;}
  el.innerHTML=hiddenCts.map(c=>`
    <div class="ct-row" style="background:#f7f8fa" onclick="openChat(${c._id})">
      <div class="ct-av">${avatarHtml(c.avatar,48)}</div>
      <div class="ct-info">
        <div class="ct-top"><span class="ct-name">${esc(c.nickname||c.name)}</span></div>
        <div class="ct-preview">
          <div class="ct-pre-txt">${esc(c.last_msg||c.status||'')}</div>
          <button onclick="event.stopPropagation();unhideChat(${c._id})" style="border:none;background:rgba(18,140,126,.12);color:var(--ac2);border-radius:8px;padding:3px 9px;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap">Unhide</button>
        </div>
      </div>
    </div>`).join('');
}
function unhideChat(id){
  const hidden=getHidden();const idx=hidden.indexOf(id);
  if(idx>-1){hidden.splice(idx,1);LS.s('hidden_chats',hidden);}
  toast('Chat unhidden','👁️');loadCts();
}

/* ── Add contact ─────────────────────────────────────────────── */
function openAdd(){document.getElementById('add-modal').classList.remove('off');setTimeout(()=>document.getElementById('add-ph').focus(),200);}
function closeAdd(){document.getElementById('add-modal').classList.add('off');}
async function doAdd(){
  const ph=(gv('add-ph')||'').trim(),nk=(gv('add-nk')||'').trim();
  if(!ph){toast('Enter a phone number','⚠️');return;}
  if(useSrv){
    const r=await api('POST','/api/contacts/request',{phone:ph,nickname:nk});
    if(r&&r.ok){toast(`Request sent to ${r.name}!`,'📨');closeAdd();sv('add-ph','');sv('add-nk','');return;}
    if(r&&r.error){toast(r.error,'❌');return;}
  }
  const u=lU(),tg=Object.values(u).find(x=>x.phone===ph);
  if(!tg){toast('No user found','❌');return;}
  if(tg.id===me.id){toast('Cannot add yourself','❌');return;}
  const l=lC(me.id);if(l.find(c=>c.cid===tg.id)){toast('Already added','❌');return;}
  l.push({cid:tg.id,nick:nk,bl:false});sC(me.id,l);toast(`${tg.name} added!`,'✅');closeAdd();sv('add-ph','');sv('add-nk','');loadCts();
}

/* ── Edit profile ────────────────────────────────────────────── */
function openEd(f){
  edF=f;
  document.getElementById('ed-ttl').textContent=f==='name'?'Edit Name':'Edit About';
  document.getElementById('ed-v').value=me[f]||'';
  document.getElementById('ed-modal').classList.remove('off');
  setTimeout(()=>document.getElementById('ed-v').focus(),200);
}
function closeEd(){document.getElementById('ed-modal').classList.add('off');}
async function saveEd(){
  const val=gv('ed-v').trim();if(!val){toast('Cannot be empty','⚠️');return;}
  me[edF]=val;LS.s('me',me);updProf();closeEd();toast('Saved!','✅');
  if(useSrv)api('POST','/api/profile/update',{name:me.name,status:me.status,avatar:me.avatar||'👤'});
  else{const u=lU();if(u[me.phone]){u[me.phone][edF]=val;sU(u);}}
}

/* ── WebRTC ──────────────────────────────────────────────────── */
let pc=null,localStream=null,callTimer=null,callSec=0;
let activeCallId=null,activeCallType=null,_muted=false,_camOff=false;
const ICE=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];

async function startCall(type){
  closeDD();
  if(!act){toast('Open a chat first','⚠️');return;}
  if(!useSrv){toast('Server required for calls','⚠️');return;}
  activeCallType=type;
  _showCallUI({name:act.nickname||act.name,avatar:act.avatar,status:'Calling…',mode:'calling'});
  try{
    localStream=await navigator.mediaDevices.getUserMedia(type==='video'?{audio:true,video:true}:{audio:true,video:false});
    if(type==='video'){const lv=document.getElementById('local-video');lv.srcObject=localStream;lv.style.display='block';}
    pc=new RTCPeerConnection({iceServers:ICE});
    localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
    pc.onicecandidate=e=>{if(e.candidate&&activeCallId)api('POST','/api/call/ice',{call_id:activeCallId,target_id:act._id,candidate:e.candidate});};
    pc.ontrack=e=>{const rv=document.getElementById('remote-video');rv.srcObject=e.streams[0];if(type==='video')rv.style.display='block';};
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    const r=await api('POST','/api/call/offer',{callee_id:act._id,call_type:type,sdp:offer});
    if(r&&r.call_id)activeCallId=r.call_id;else{toast('Could not place call','❌');cleanupCall();}
  }catch(e){toast('Mic/camera error: '+e.message,'❌');cleanupCall();}
}
function onCallOffer(msg){activeCallId=msg.call_id;activeCallType=msg.call_type;window._pendingOffer=msg;_showCallUI({name:msg.from_name,avatar:msg.from_avatar,status:(msg.call_type==='video'?'📹 Video':'📞 Audio')+' call…',mode:'incoming'});}
async function answerCall(){
  const offer=window._pendingOffer;if(!offer)return;
  _showCallUI({name:offer.from_name,avatar:offer.from_avatar,status:'Connecting…',mode:'calling'});
  try{
    localStream=await navigator.mediaDevices.getUserMedia(activeCallType==='video'?{audio:true,video:true}:{audio:true,video:false});
    if(activeCallType==='video'){const lv=document.getElementById('local-video');lv.srcObject=localStream;lv.style.display='block';}
    pc=new RTCPeerConnection({iceServers:ICE});
    localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
    pc.onicecandidate=e=>{if(e.candidate&&activeCallId)api('POST','/api/call/ice',{call_id:activeCallId,target_id:offer.from,candidate:e.candidate});};
    pc.ontrack=e=>{const rv=document.getElementById('remote-video');rv.srcObject=e.streams[0];if(activeCallType==='video')rv.style.display='block';};
    await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
    const ans=await pc.createAnswer();await pc.setLocalDescription(ans);
    await api('POST','/api/call/answer',{call_id:activeCallId,sdp:ans});
    _startCallTimer();
    _showCallUI({name:offer.from_name,avatar:offer.from_avatar,status:activeCallType==='video'?'📹 Video call':'📞 Audio call',mode:'live'});
  }catch(e){toast('Answer error: '+e.message,'❌');cleanupCall();}
}
async function onCallAnswer(msg){if(!pc)return;await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));_startCallTimer();_showCallUI({name:act?.name||'',avatar:act?.avatar,status:activeCallType==='video'?'📹 Video call':'📞 Audio call',mode:'live'});}
async function onIceCandidate(msg){if(pc&&msg.candidate)try{await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));}catch{}}
function onCallEnded(){cleanupCall();toast('Call ended','📵');loadCallHistory();}
async function rejectCall(){if(activeCallId)await api('POST','/api/call/reject',{call_id:activeCallId});cleanupCall();}
async function endCall(){if(activeCallId)await api('POST','/api/call/end',{call_id:activeCallId});cleanupCall();}
function cleanupCall(){
  if(localStream)localStream.getTracks().forEach(t=>t.stop());
  if(pc)pc.close();localStream=pc=null;activeCallId=null;_muted=_camOff=false;
  clearInterval(callTimer);callSec=0;
  document.getElementById('call-overlay').classList.add('off');
  const rv=document.getElementById('remote-video');rv.style.display='none';rv.srcObject=null;
  const lv=document.getElementById('local-video');lv.style.display='none';lv.srcObject=null;
  window._pendingOffer=null;
}
function _startCallTimer(){
  callSec=0;const el=document.getElementById('co-timer');el.style.display='block';clearInterval(callTimer);
  callTimer=setInterval(()=>{callSec++;el.textContent=Math.floor(callSec/60)+':'+(callSec%60).toString().padStart(2,'0');},1000);
}
function _showCallUI({name,avatar,status,mode}){
  const wrap=document.getElementById('co-av-wrap');
  wrap.innerHTML=avatar&&(avatar.startsWith('data:')||avatar.startsWith('/'))
    ?`<img src="${avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
    :`<span style="font-size:58px">${avatar||'👤'}</span>`;
  document.getElementById('co-name').textContent=name||'';
  document.getElementById('co-status').textContent=status;
  document.getElementById('co-act-calling').style.display=mode==='calling'?'flex':'none';
  document.getElementById('co-act-incoming').style.display=mode==='incoming'?'flex':'none';
  document.getElementById('co-act-live').style.display=mode==='live'?'flex':'none';
  wrap.parentElement?.classList.toggle('ringing',mode==='incoming');
  document.getElementById('call-overlay').classList.remove('off');
}
function toggleMute(){_muted=!_muted;if(localStream)localStream.getAudioTracks().forEach(t=>t.enabled=!_muted);document.getElementById('btn-mute').textContent=_muted?'🔇':'🎤';}
function toggleCam(){_camOff=!_camOff;if(localStream)localStream.getVideoTracks().forEach(t=>t.enabled=!_camOff);document.getElementById('btn-cam').textContent=_camOff?'📵':'📷';}

/* ── Emoji / stickers ────────────────────────────────────────── */
let epOpen=false;
function toggleEmoji(){const ep=document.getElementById('emoji-picker');epOpen=!epOpen;ep.style.display=epOpen?'flex':'none';closeFilePicker();}
function closeEmoji(){epOpen=false;document.getElementById('emoji-picker').style.display='none';}
function ins(e){document.getElementById('ita').value+=e;closeEmoji();}
function toggleStickers(){const sr=document.getElementById('sticker-row');sr.style.display=sr.style.display==='none'?'block':'none';closeEmoji();}

function closeAllPickers(){closeEmoji();closeFilePicker();document.getElementById('sticker-row').style.display='none';}

/* ── Utils ───────────────────────────────────────────────────── */
const gv=id=>(document.getElementById(id)||{}).value||'';
const sv=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function ft(ts){const d=new Date(ts*1000);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function fd(ts){
  const d=new Date(ts*1000),n=new Date();
  if(d.toDateString()===n.toDateString())return'Today';
  const y=new Date(n);y.setDate(n.getDate()-1);
  if(d.toDateString()===y.toDateString())return'Yesterday';
  return d.toLocaleDateString([],{weekday:'long',month:'short',day:'numeric'});
}
function frel(ts){
  const diff=Date.now()/1000-ts;
  if(diff<60)return'just now';if(diff<3600)return Math.floor(diff/60)+'m ago';
  if(diff<86400)return ft(ts);return new Date(ts*1000).toLocaleDateString([],{month:'short',day:'numeric'});
}
function hk(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}else sendTyping();}
function ar(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}

/* ── Global events ───────────────────────────────────────────── */
document.addEventListener('click',e=>{
  if(!e.target.closest('#emoji-picker')&&!e.target.closest('.input-icon-btn'))closeEmoji();
  if(!e.target.closest('#file-type-picker')&&!e.target.closest('.input-icon-btn'))closeFilePicker();
  if(e.target.id==='add-modal')closeAdd();
  if(e.target.id==='ed-modal')closeEd();
  if(e.target.id==='req-modal')closeRequests();
  if(e.target.id==='contact-profile-modal')closeContactProfile();
  if(e.target.id==='story-modal')closeAddStory();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.id==='si-pw')doSI();
  if(e.key==='Enter'&&e.target.id==='su-pw2')doSU();
  if(e.key==='Enter'&&e.target.id==='add-ph')doAdd();
  if(e.key==='Enter'&&e.target.id==='ed-v')saveEd();
  if(e.key==='Escape'){closeAdd();closeEd();closeEmoji();closeFilePicker();closeDD();closeLightbox();closeRequests();closeContactProfile();closeAddStory();closeStoryViewer();}
});

setInterval(async()=>{if(!useSrv){await probe();if(useSrv&&token)connectWS();}},30000);


/* ══════════════════════════════════════════════════════════════════
   CHAT THEME & WALLPAPER ENGINE
   ══════════════════════════════════════════════════════════════════ */
const THEMES=[
  {id:'default',name:'WhatsApp',ac:'#075e54',ac2:'#128c7e',out:'#dcf8c6',bg:'#e5ddd5',dark:false},
  {id:'ocean',name:'Ocean',ac:'#0051a8',ac2:'#1565c0',out:'#bbdefb',bg:'#cfe8fc',dark:false},
  {id:'purple',name:'Purple',ac:'#6a1b9a',ac2:'#8e24aa',out:'#e1bee7',bg:'#f1e6fa',dark:false},
  {id:'rose',name:'Rose',ac:'#ad1457',ac2:'#c2185b',out:'#fce4ec',bg:'#fdeef4',dark:false},
  {id:'teal',name:'Teal',ac:'#00695c',ac2:'#00796b',out:'#b2dfdb',bg:'#e0f2f1',dark:false},
  {id:'dark',name:'Dark',ac:'#1e1e2e',ac2:'#7c6af7',out:'#45475a',bg:'#1e1e2e',dark:true},
  {id:'sunset',name:'Sunset',ac:'#c62828',ac2:'#e53935',out:'#ffccbc',bg:'#ffeee8',dark:false},
  {id:'forest',name:'Forest',ac:'#2e7d32',ac2:'#388e3c',out:'#c8e6c9',bg:'#ecf7ed',dark:false},
];
const WALLPAPERS=[
  {id:'none',name:'None',css:''},
  {id:'dots',name:'Dots',css:'radial-gradient(rgba(0,0,0,.08) 1px,transparent 1px) 0 0/20px 20px'},
  {id:'grid',name:'Grid',css:'linear-gradient(rgba(0,0,0,.05) 1px,transparent 1px) 0 0/24px 24px,linear-gradient(90deg,rgba(0,0,0,.05) 1px,transparent 1px) 0 0/24px 24px'},
  {id:'waves',name:'Waves',css:'repeating-linear-gradient(45deg,rgba(0,0,0,.04) 0,rgba(0,0,0,.04) 1px,transparent 0,transparent 50%) 0/14px 14px'},
  {id:'mint',name:'Mint',css:'linear-gradient(135deg,#e0f7fa,#b2ebf2,#e8f5e9)'},
  {id:'lavender',name:'Lavender',css:'linear-gradient(135deg,#f3e5f5,#e8eaf6,#fce4ec)'},
  {id:'peach',name:'Peach',css:'linear-gradient(135deg,#fff8e1,#ffe0b2,#fce4ec)'},
  {id:'sky',name:'Sky',css:'linear-gradient(160deg,#e3f2fd,#e0f2f1,#f3e5f5)'},
];

let currentThemeId=LS.g('theme_id')||'default';
let currentWallpaper=LS.g('wallpaper')||'none';
let currentWallpaperUrl=LS.g('wallpaper_url')||'';
let currentBubbleStyle=LS.g('bubble_style')||'classic';
let currentFontSize=parseInt(LS.g('font_size')||'14');

function applyTheme(){
  const theme=THEMES.find(t=>t.id===currentThemeId)||THEMES[0];
  const root=document.documentElement;
  root.style.setProperty('--ac',theme.ac);
  root.style.setProperty('--ac2',theme.ac2);
  root.style.setProperty('--out',theme.out);
  if(theme.dark){
    root.style.setProperty('--tx','#cdd6f4');
    root.style.setProperty('--t2','#a6adc8');
    root.style.setProperty('--t3','#6c7086');
    root.style.setProperty('--bg','#1e1e2e');
    root.style.setProperty('--panel','#181825');
    root.style.setProperty('--s2','#313244');
    root.style.setProperty('--bd','#45475a');
    root.style.setProperty('--in','#313244');
    root.style.setProperty('--hdr','#181825');
  } else {
    root.style.setProperty('--tx','#111b21');
    root.style.setProperty('--t2','#54656f');
    root.style.setProperty('--t3','#8696a0');
    root.style.setProperty('--bg','#f0f2f5');
    root.style.setProperty('--panel','#fff');
    root.style.setProperty('--s2','#f7f8fa');
    root.style.setProperty('--bd','#e4e8ed');
    root.style.setProperty('--in','#fff');
    root.style.setProperty('--hdr','#f0f2f5');
  }
  applyWallpaper();
  applyBubbleStyle();
  applyFontSize();
}

function applyWallpaper(){
  const area=document.getElementById('chat-area');if(!area)return;
  if(currentWallpaperUrl){
    area.style.backgroundImage='url('+JSON.stringify(currentWallpaperUrl)+')';
    area.style.backgroundSize='cover';area.style.backgroundPosition='center';
    area.style.backgroundColor='';return;
  }
  const wp=WALLPAPERS.find(w=>w.id===currentWallpaper)||WALLPAPERS[0];
  if(wp.css){
    area.style.backgroundImage=wp.css;area.style.backgroundSize='';area.style.backgroundPosition='';
    area.style.backgroundColor='var(--bg)';
  } else {
    const theme=THEMES.find(t=>t.id===currentThemeId)||THEMES[0];
    area.style.backgroundImage='none';
    area.style.backgroundColor=theme.bg;
  }
}

function applyBubbleStyle(){
  const styles={
    classic:{out:'15px 4px 15px 15px',in:'4px 15px 15px 15px'},
    rounded:{out:'22px 4px 22px 22px',in:'4px 22px 22px 22px'},
    sharp:{out:'4px',in:'4px'},
    modern:{out:'18px 18px 4px 18px',in:'18px 18px 18px 4px'},
  };
  const s=styles[currentBubbleStyle]||styles.classic;
  let el=document.getElementById('bubble-style-override');
  if(!el){el=document.createElement('style');el.id='bubble-style-override';document.head.appendChild(el);}
  el.textContent='.out .bubble{border-radius:'+s.out+'!important}.in .bubble{border-radius:'+s.in+'!important}';
}

function applyFontSize(){
  let el=document.getElementById('font-size-override');
  if(!el){el=document.createElement('style');el.id='font-size-override';document.head.appendChild(el);}
  el.textContent='.bubble{font-size:'+currentFontSize+'px!important}.input-textarea{font-size:'+currentFontSize+'px!important}';
}

function openTheme(){
  renderThemeModal();
  document.getElementById('theme-modal').classList.remove('off');
}
function closeTheme(){document.getElementById('theme-modal').classList.add('off');}

function renderThemeModal(){
  const cg=document.getElementById('theme-color-grid');
  if(cg){cg.innerHTML=THEMES.map(t=>'<div><div class="theme-color-swatch'+(currentThemeId===t.id?' active':'')+'" id="swatch-'+t.id+'" style="background:linear-gradient(135deg,'+t.ac+','+t.ac2+')" onclick="selectTheme(\''+t.id+'\')"><span class="swatch-check">✓</span></div><div class="theme-color-name">'+t.name+'</div></div>').join('');}
  const wg=document.getElementById('wallpaper-grid');
  if(wg){wg.innerHTML=WALLPAPERS.map(wp=>{
    const isActive=(currentWallpaper===wp.id&&!currentWallpaperUrl)||(wp.id==='none'&&!currentWallpaperUrl&&currentWallpaper==='none');
    const preview=wp.css?'<div style="width:100%;height:100%;background:'+wp.css+'"></div>':'<div style="width:100%;height:100%;background:#e5ddd5;display:flex;align-items:center;justify-content:center;font-size:20px">✕</div>';
    return'<div><div class="wallpaper-thumb'+(isActive?' active':'')+'" id="wp-'+wp.id+'" onclick="selectWallpaper(\''+wp.id+'\')">'+preview+'<div class="wp-check">✓</div></div><div class="theme-color-name">'+wp.name+'</div></div>';
  }).join('');}
  ['classic','rounded','sharp','modern'].forEach(s=>{
    const el=document.getElementById('bstyle-'+s);if(el)el.classList.toggle('active',currentBubbleStyle===s);
  });
  const slider=document.getElementById('font-size-slider');
  const label=document.getElementById('font-size-label');
  if(slider)slider.value=currentFontSize;
  if(label)label.textContent=currentFontSize+'px';
  if(currentWallpaperUrl){
    document.querySelectorAll('.wallpaper-thumb').forEach(el=>el.classList.remove('active'));
  }
}

function selectTheme(id){
  currentThemeId=id;LS.s('theme_id',id);
  document.querySelectorAll('.theme-color-swatch').forEach(el=>el.classList.remove('active'));
  const sw=document.getElementById('swatch-'+id);if(sw)sw.classList.add('active');
  applyTheme();
}

function selectWallpaper(id){
  currentWallpaper=id;currentWallpaperUrl='';
  LS.s('wallpaper',id);LS.s('wallpaper_url','');
  document.querySelectorAll('.wallpaper-thumb').forEach(el=>el.classList.remove('active'));
  const wp=document.getElementById('wp-'+id);if(wp)wp.classList.add('active');
  applyWallpaper();
}

function setBubbleStyle(style){
  currentBubbleStyle=style;LS.s('bubble_style',style);
  ['classic','rounded','sharp','modern'].forEach(s=>{const el=document.getElementById('bstyle-'+s);if(el)el.classList.toggle('active',s===style);});
  applyBubbleStyle();
}

function setFontSize(val){
  currentFontSize=parseInt(val);LS.s('font_size',String(val));
  const label=document.getElementById('font-size-label');if(label)label.textContent=val+'px';
  applyFontSize();
}

function onWallpaperSelected(input){
  const file=input.files[0];if(!file)return;
  if(!file.type.startsWith('image/')){toast('Select an image file','❌');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    currentWallpaperUrl=e.target.result;currentWallpaper='custom';
    LS.s('wallpaper_url',currentWallpaperUrl);LS.s('wallpaper','custom');
    applyWallpaper();toast('Wallpaper applied!','🖼️');
    document.querySelectorAll('.wallpaper-thumb').forEach(el=>el.classList.remove('active'));
  };
  reader.readAsDataURL(file);
  input.value='';
}

function resetTheme(){
  currentThemeId='default';currentWallpaper='none';currentWallpaperUrl='';currentBubbleStyle='classic';currentFontSize=14;
  LS.d('theme_id');LS.d('wallpaper');LS.d('wallpaper_url');LS.d('bubble_style');LS.d('font_size');
  applyTheme();renderThemeModal();toast('Theme reset','✅');
}

/* ── Boot ────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded',async()=>{
  // Show splash for at least 1.5s
  await new Promise(r=>setTimeout(r,1500));
  await probe();
  if(token){
    if(useSrv){
      const r=await api('GET','/api/me');
      if(r&&!r.error){me=r;LS.s('me',r);document.getElementById('splash').classList.add('fade');setTimeout(()=>{document.getElementById('splash').style.display='none';},500);enterApp();return;}
      token='';LS.d('tok');LS.d('me');me=null;
    } else if(me){
      document.getElementById('splash').classList.add('fade');setTimeout(()=>{document.getElementById('splash').style.display='none';},500);enterApp();return;
    }
  }
  // Show auth
  document.getElementById('splash').classList.add('fade');
  setTimeout(()=>{document.getElementById('splash').style.display='none';document.getElementById('page-auth').classList.remove('off');},500);
});
