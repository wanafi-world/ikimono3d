// いきもの採集 3D — claude.ai の保存・通信のかわりに Firebase Realtime Database を使うための部品。
// ゲーム本体は window.claude.use('db' | 'user' | 'room' | 'downloads') を呼ぶので、同じ形で Firebase につなぐ。
(function(){
  'use strict';
  const FAM_KEY = 'ikimono3d_family';
  const cfg = window.FIREBASE_CONFIG;
  let app = null, rtdb = null;
  try{
    if(cfg && cfg.databaseURL && window.firebase){ app = firebase.initializeApp(cfg); rtdb = firebase.database(); }
  }catch(e){ console.warn('firebase init failed', e); rtdb = null; }

  // ---------- 家族のあいことば ----------
  async function sha256(s){
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  const norm = s => String(s||'').normalize('NFKC').trim().replace(/\s+/g,'').toLowerCase();
  function askFamily(){
    return new Promise(res=>{
      const ov = document.createElement('div');
      ov.className = 'overlay'; ov.style.cssText = 'display:flex;z-index:90';
      ov.innerHTML = '<div class="panel" style="text-align:center"><h2>🔑 家族のあいことば</h2>'+
        '<p style="font-size:16px">セーブと協力プレイを、家族のiPadどうしでつなぐための「あいことば」を入れてね。<br><b>2台とも同じあいことば</b>を入れると、同じセーブで遊べて、いっしょに冒険できるよ。<br><small>（6文字以上。家族だけが知っている言葉にしてね。あとから「💾」の画面で変えられるよ）</small></p>'+
        '<input id="famIn" maxlength="60" autocomplete="off" autocapitalize="off" style="font-size:20px;padding:8px 10px;border-radius:10px;border:3px solid #3a2a12;width:min(100%,360px);-webkit-user-select:text;user-select:text;touch-action:auto">'+
        '<div id="famMsg" style="color:#c0392b;font-weight:bold;min-height:22px;margin-top:6px"></div>'+
        '<div class="row"><button class="btn" id="famOk">✅ これにする</button><button class="btn" id="famSkip" style="font-size:15px">あとで（この端末だけに保存）</button></div></div>';
      document.body.appendChild(ov);
      const inp = ov.querySelector('#famIn'), msg = ov.querySelector('#famMsg');
      ['keydown','keyup','keypress'].forEach(t=>inp.addEventListener(t,e=>e.stopPropagation()));
      ov.querySelector('#famOk').onclick = ()=>{
        const v = norm(inp.value);
        if(v.length < 6){ msg.textContent = '6文字以上にしてね'; return; }
        try{ localStorage.setItem(FAM_KEY, v); }catch(e){}
        ov.remove(); res(v);
      };
      ov.querySelector('#famSkip').onclick = ()=>{ ov.remove(); res(null); };
      setTimeout(()=>{ try{ inp.focus(); }catch(e){} }, 50);
    });
  }
  let famP = null;
  function famId(){
    if(!rtdb) return Promise.resolve(null);
    if(!famP) famP = (async()=>{
      let v = null; try{ v = localStorage.getItem(FAM_KEY); }catch(e){}
      if(!v) v = await askFamily();
      if(!v) return null;
      return await sha256('ikimono3d-family:' + v);
    })();
    return famP;
  }
  window.ikiChangeFamily = async function(){
    try{ localStorage.removeItem(FAM_KEY); }catch(e){}
    location.reload();
  };

  // ---------- 時間切れつきの Promise ----------
  const withTimeout = (p, ms) => new Promise((res, rej)=>{
    const t = setTimeout(()=>rej(new Error('timeout')), ms);
    p.then(v=>{ clearTimeout(t); res(v); }, e=>{ clearTimeout(t); rej(e); });
  });
  const enc = k => String(k).replace(/[.#$\[\]\/%]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const dec = k => String(k).replace(/%([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

  // ---------- db（セーブの保管場所） ----------
  // ゲームは db.collection('data/users/' + uid) を使う。uid は家族のあいことばのハッシュ。
  function makeDb(){
    return {
      collection(path){
        const uid = String(path).split('/').pop();
        const base = rtdb.ref('fam/' + uid + '/s');
        return {
          doc(id){
            const r = base.child(enc(id));
            return {
              async get(){ const s = await withTimeout(r.get(), 12000); const v = s.val(); return { exists: v != null, id, data: () => v }; },
              async set(obj){ await withTimeout(r.set(obj), 20000); },
              async delete(){ await withTimeout(r.remove(), 12000); }
            };
          },
          async get(){
            const s = await withTimeout(base.get(), 15000); const docs = [];
            s.forEach(c => { const v = c.val(); docs.push({ id: dec(c.key), data: () => v }); });
            return { docs };
          }
        };
      }
    };
  }

  // ---------- room（協力プレイの通信） ----------
  function makeRoom(uid){
    const root = rtdb.ref('fam/' + uid + '/room');
    const me = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    let conn = false;
    rtdb.ref('.info/connected').on('value', s => { conn = !!s.val(); });
    const pRef = root.child('p'), coRef = root.child('co');
    const myP = pRef.child(me);
    myP.onDisconnect().remove();
    window.addEventListener('pagehide', () => { try{ myP.remove(); }catch(e){} });
    // 古い合図をそうじする（10分より前のもの）
    const startKey = coRef.push().key;
    try{
      const oldKey = (function(){ const t = Date.now() - 600000; const C = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'; let k = '', n = t; for(let i = 0; i < 8; i++){ k = C.charAt(n % 64) + k; n = Math.floor(n / 64); } return k; })();
      coRef.orderByKey().endAt(oldKey).limitToFirst(200).get().then(s => { const u = {}; s.forEach(c => { u[c.key] = null; }); if(Object.keys(u).length) coRef.update(u).catch(()=>{}); }).catch(()=>{});
    }catch(e){}
    const mine = [];
    const handlers = { p: [], co: [] };
    function deliver(topic, key, v){
      if(!v || typeof v !== 'object') return;
      const m = { data: v.d, peer: v.peer || key, sameTab: (v.peer || key) === me, isMe: (v.peer || key) === me };
      for(const h of handlers[topic]) try{ h(m); }catch(e){ console.warn(e); }
    }
    pRef.on('child_added', s => deliver('p', s.key, s.val()));
    pRef.on('child_changed', s => deliver('p', s.key, s.val()));
    coRef.orderByKey().startAt(startKey).on('child_added', s => deliver('co', s.key, s.val()));
    return {
      connected: () => conn,
      on(topic, h){ if(handlers[topic]) handlers[topic].push(h); return () => { const a = handlers[topic]; const i = a.indexOf(h); if(i >= 0) a.splice(i, 1); }; },
      async emit(topic, data){
        const d = JSON.parse(JSON.stringify(data === undefined ? null : data));
        if(topic === 'p'){ await myP.set({ d, peer: me, t: firebase.database.ServerValue.TIMESTAMP }); return; }
        const r = coRef.push(); mine.push(r);
        if(mine.length > 40){ const old = mine.shift(); old.remove().catch(()=>{}); }
        await r.set({ d, peer: me, t: firebase.database.ServerValue.TIMESTAMP });
      },
      peers: () => [], presence: () => []
    };
  }

  // ---------- window.claude のかわり ----------
  let roomP = null;
  window.claude = {
    async use(name){
      if(!rtdb) return null;
      if(name === 'user') return { id: () => famId() };
      if(name === 'db') return makeDb();
      if(name === 'room'){
        if(!roomP) roomP = famId().then(uid => uid ? makeRoom(uid) : null).catch(() => null);
        return roomP;
      }
      return null; // downloads などは、ゲームのふつうのやり方を使う
    }
  };

  // 💾 の画面に「あいことばを変える」ボタンを足す
  function addFamBtn(){
    const sec = document.getElementById('cloudSec'); if(!sec || document.getElementById('famChange')) return;
    const d = document.createElement('div'); d.style.marginTop = '6px';
    d.innerHTML = '<button class="btn" id="famChange" style="font-size:14px">🔑 家族のあいことばを変える</button>';
    sec.appendChild(d);
    d.querySelector('#famChange').onclick = () => window.ikiChangeFamily();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addFamBtn); else addFamBtn();
})();
