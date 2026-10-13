/* M Song - واجهة التطبيق (بدون أي مكتبات خارجية) */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = m => { const v = m / 1e6; return '$' + (Math.abs(v) < 1 && v !== 0 ? v.toFixed(4) : v.toFixed(2)); };
const dt = t => new Date(t).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' });
const fmtTime = s => { s = Math.floor(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const num = n => Number(n).toLocaleString('en-US');

let me = null, unread = 0;

async function api(url, opts = {}) {
  const o = { method: 'GET', credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(o.body); }
  const r = await fetch('/api' + url, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'حدث خطأ');
  return j;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
}
const view = html => { $('#view').innerHTML = html; window.scrollTo(0, 0); };

/* ---------- المشغل ---------- */
const audio = $('#audio');
const P = { queue: [], i: -1, token: null, counted: false, listened: 0, last: 0 };
const coverStyle = s => s.cover ? `style="background-image:url('${esc(s.cover)}')"` : '';
const coverTxt = s => s.cover ? '' : esc((s.title || '♪')[0]);

function playQueue(songs, i) {
  P.queue = songs; P.i = i; loadCurrent(true);
}
function loadCurrent(autoplay) {
  const s = P.queue[P.i]; if (!s) return;
  $('#player').hidden = false;
  audio.src = s.audio; P.token = null; P.counted = false; P.listened = 0; P.last = 0;
  $('#p-title').textContent = s.title; $('#p-artist').textContent = s.artist_name;
  const c = $('#p-cover'); c.style.backgroundImage = s.cover ? `url('${s.cover}')` : ''; c.textContent = coverTxt(s);
  updateLike();
  if (autoplay) audio.play().catch(() => {});
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist_name });
}
function updateLike() {
  const s = P.queue[P.i]; const b = $('#p-like'); if (!s) return;
  b.textContent = s.liked ? '♥' : '♡'; b.classList.toggle('liked', !!s.liked);
}
const step = d => { if (!P.queue.length) return; P.i = (P.i + d + P.queue.length) % P.queue.length; loadCurrent(true); };

$('#p-play').onclick = () => (audio.paused ? audio.play() : audio.pause());
$('#p-next').onclick = () => step(1);
$('#p-prev').onclick = () => (audio.currentTime > 4 ? (audio.currentTime = 0) : step(-1));
$('#p-vol').oninput = e => (audio.volume = e.target.value / 100);
audio.volume = 0.8;
$('#p-bar').oninput = e => { if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration; };
audio.onplay = () => ($('#p-play').textContent = '⏸');
audio.onpause = () => ($('#p-play').textContent = '▶');
audio.onended = () => step(1);
audio.onloadedmetadata = () => ($('#p-dur').textContent = fmtTime(audio.duration));
$('#p-like').onclick = async () => { const s = P.queue[P.i]; if (s) await toggleLike(s); };

audio.onplaying = async () => {
  const s = P.queue[P.i];
  if (!s || P.token || !me) return;
  try { P.token = (await api(`/songs/${s.id}/play-start`, { method: 'POST' })).token; } catch { /* تجاهل */ }
};
audio.ontimeupdate = async () => {
  if (audio.duration) $('#p-bar').value = (audio.currentTime / audio.duration) * 1000;
  $('#p-cur').textContent = fmtTime(audio.currentTime);
  // نحتسب فقط وقت الاستماع الفعلي المتصل (القفز للأمام لا يُحتسب)
  const d = audio.currentTime - P.last; P.last = audio.currentTime;
  if (!audio.paused && d > 0 && d < 1.5) P.listened += d;
  if (!P.counted && P.token && P.listened >= 30) {
    P.counted = true;
    try { await api('/listen', { method: 'POST', body: { token: P.token } }); } catch { /* الخادم يقرر التأهل */ }
  }
};

async function toggleLike(s) {
  if (!me) { location.hash = '#/login'; return toast('سجّل الدخول للإعجاب بالأغاني'); }
  const r = await api(`/songs/${s.id}/like`, { method: 'POST' });
  s.liked = r.liked;
  P.queue.forEach(x => { if (x.id === s.id) x.liked = r.liked; });
  updateLike();
  toast(r.liked ? 'أُضيفت إلى المفضلة' : 'أُزيلت من المفضلة');
}

/* ---------- مكونات ---------- */
let LIST = []; // قائمة الأغاني المعروضة حاليًا (لزر التشغيل)
function songCards(songs) {
  if (!songs.length) return '<div class="empty">لا توجد أغانٍ بعد</div>';
  return `<div class="grid">${songs.map((s, i) => `
    <div class="card" data-play="${i}">
      <div class="cover" ${coverStyle(s)}>${coverTxt(s)}</div>
      <div class="t">${esc(s.title)}</div>
      <div class="a">${esc(s.artist_name)}</div>
      <div class="m">▶ ${num(s.plays)} &nbsp; ♥ ${num(s.likes)}</div>
    </div>`).join('')}</div>`;
}
function songRows(songs, extra) {
  if (!songs.length) return '<div class="empty">لا توجد أغانٍ</div>';
  return songs.map((s, i) => `
    <div class="row" data-play="${i}">
      <div class="cover sm" ${coverStyle(s)}>${coverTxt(s)}</div>
      <div class="grow"><div class="t">${esc(s.title)}</div><div class="muted small">${esc(s.artist_name)} · ▶ ${num(s.plays)}${extra ? extra(s) : ''}</div></div>
      <button class="icon ${s.liked ? 'liked' : ''}" data-like="${i}" aria-label="إعجاب">${s.liked ? '♥' : '♡'}</button>
    </div>`).join('');
}
function bindSongs(root, songs) {
  LIST = songs;
  $$('[data-play]', root).forEach(el => el.onclick = e => {
    if (e.target.closest('[data-like]')) return;
    playQueue(LIST, +el.dataset.play);
  });
  $$('[data-like]', root).forEach(el => el.onclick = async e => {
    e.stopPropagation();
    const s = LIST[+el.dataset.like]; await toggleLike(s);
    el.textContent = s.liked ? '♥' : '♡'; el.classList.toggle('liked', s.liked);
  });
}
const badge = s => `<span class="badge b-${s}">${({ review: 'قيد المراجعة', approved: 'مقبولة', rejected: 'مرفوضة', completed: 'مكتملة', published: 'منشورة', removed: 'محذوفة' })[s] || s}</span>`;
const needLogin = () => { view('<div class="panel">يجب <a class="gold" href="#/login">تسجيل الدخول</a> أولًا.</div>'); };

/* ---------- الصفحات ---------- */
const routes = {};

routes.home = async () => {
  const [n, t, tr, r] = await Promise.all(['new', 'top', 'trending', 'random'].map(k => api(`/songs?sort=${k}&limit=12`)));
  const all = [];
  const sec = (title, list) => { const off = all.length; all.push(...list); return { title, list, off }; };
  const secs = [sec('الأغاني الجديدة', n.songs), sec('الأكثر استماعًا', t.songs), sec('الرائجة هذا الأسبوع', tr.songs), sec('اقتراحات لك', r.songs)];
  view(secs.map(s => `<h2>${s.title}</h2><div data-sec="${s.off}">${songCards(s.list)}</div>`).join('') +
    (all.length ? '' : `<div class="panel">لا توجد أغانٍ بعد. كن أول من ينشر أغنيته على M Song! <a class="gold" href="#/upload">انشر أغنية</a></div>`));
  $$('[data-sec]').forEach((el, k) => bindSongs(el, secs[k].list));
};

routes.search = async q => {
  q = decodeURIComponent(q || '');
  $('#q').value = q;
  const r = await api('/search?q=' + encodeURIComponent(q));
  view(`<h1>نتائج: ${esc(q)}</h1>
    ${r.artists.length ? `<h2>الفنانون</h2><div class="panel">${r.artists.map(a => `<a class="row" href="#/artist/${esc(a.username)}"><div class="cover sm" ${a.avatar ? `style="background-image:url('${esc(a.avatar)}')"` : ''}>${a.avatar ? '' : esc(a.display_name[0])}</div><div class="grow"><div class="t">${esc(a.display_name)}</div><div class="muted small">${a.songs} أغنية</div></div></a>`).join('')}</div>` : ''}
    <h2>الأغاني</h2><div class="panel" id="res">${songRows(r.songs)}</div>`);
  bindSongs($('#res'), r.songs);
};

routes.artist = async username => {
  const r = await api('/artists/' + encodeURIComponent(username));
  const a = r.artist;
  const mine = me && me.id === a.id;
  view(`<div class="hero">
      <div class="cover" ${a.avatar ? `style="background-image:url('${esc(a.avatar)}')"` : ''}>${a.avatar ? '' : esc(a.display_name[0])}</div>
      <div><h1 style="margin:0">${esc(a.display_name)}</h1><div class="muted">@${esc(a.username)}</div><p class="small">${esc(a.bio)}</p></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="l">الأغاني</div><div class="v">${r.songs.length}</div></div>
      <div class="stat"><div class="l">إجمالي الاستماعات</div><div class="v">${num(r.total_plays)}</div></div>
      ${r.total_earned !== undefined ? `<div class="stat hl"><div class="l">مجموع الأرباح</div><div class="v">${usd(r.total_earned)}</div></div>` : ''}
    </div>
    <div class="panel" id="res">${songRows(r.songs, s => (s.earned !== undefined ? ` · ربح ${usd(s.earned)}` : ''))}</div>
    ${mine ? '<a class="btn ghost" href="#/profile">تعديل الملف الشخصي</a>' : ''}`);
  bindSongs($('#res'), r.songs);
};

routes.library = async () => {
  if (!me) return needLogin();
  const r = await api('/me/likes');
  view(`<h1>المفضلة</h1><div class="panel" id="res">${songRows(r.songs)}</div>`);
  bindSongs($('#res'), r.songs);
};

function authForm(mode) {
  const reg = mode === 'register';
  view(`<h1>${reg ? 'إنشاء حساب' : 'تسجيل الدخول'}</h1>
    <form class="f" id="af">
      ${reg ? '<label class="l">اسم المستخدم (إنجليزي)<input name="username" required minlength="3" maxlength="20" pattern="[a-zA-Z0-9_]+" autocomplete="username"></label><label class="l">البريد الإلكتروني<input name="email" type="email" required autocomplete="email"></label>'
        : '<label class="l">اسم المستخدم أو البريد<input name="login" required autocomplete="username"></label>'}
      <label class="l">كلمة المرور${reg ? ' (8 أحرف على الأقل)' : ''}<input name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
      <div class="err" id="err"></div>
      <button class="btn">${reg ? 'إنشاء الحساب' : 'دخول'}</button>
      <div class="muted small">${reg ? 'لديك حساب؟ <a class="gold" href="#/login">سجّل الدخول</a>' : 'ليس لديك حساب؟ <a class="gold" href="#/register">أنشئ حسابًا</a>'}</div>
    </form>`);
  $('#af').onsubmit = async e => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(e.target));
      await api('/auth/' + (reg ? 'register' : 'login'), { method: 'POST', body });
      await boot(); location.hash = '#/';
    } catch (x) { $('#err').textContent = x.message; }
  };
}
routes.login = () => authForm('login');
routes.register = () => authForm('register');

routes.upload = () => {
  if (!me) return needLogin();
  view(`<h1>نشر أغنية</h1>
    <form class="f" id="uf">
      <label class="l">اسم الأغنية<input name="title" required maxlength="100"></label>
      <label class="l">اسم الفنان<input name="artist_name" maxlength="80" value="${esc(me.display_name)}"></label>
      <label class="l">الوصف<textarea name="description" rows="3" maxlength="1000"></textarea></label>
      <label class="l">ملف الأغنية (MP3/WAV/OGG/M4A حتى 40MB)<input type="file" name="audio" accept="audio/*" required></label>
      <label class="l">صورة الغلاف (اختياري)<input type="file" name="cover" accept="image/jpeg,image/png,image/webp"></label>
      <label class="check"><input type="checkbox" name="rights" value="yes" required> أقرّ بأنني أملك كامل حقوق هذه الأغنية (أو لدي إذن بنشرها)، وأتحمل المسؤولية عن أي مخالفة لحقوق النشر. يحق للإدارة حذف أي محتوى مخالف.</label>
      <div class="err" id="err"></div>
      <button class="btn" id="ub">نشر</button>
    </form>`);
  $('#uf').onsubmit = async e => {
    e.preventDefault(); $('#ub').disabled = true; $('#err').textContent = 'جارٍ الرفع…';
    try {
      const fd = new FormData(e.target);
      if (!fd.get('cover').size) fd.delete('cover');
      await api('/songs', { method: 'POST', body: fd });
      toast('تم نشر الأغنية'); location.hash = '#/artist/' + me.username;
    } catch (x) { $('#err').textContent = x.message; $('#ub').disabled = false; }
  };
};

routes.profile = () => {
  if (!me) return needLogin();
  view(`<h1>الملف الشخصي</h1>
    <form class="f" id="pf">
      <label class="l">الاسم الظاهر<input name="display_name" value="${esc(me.display_name)}" maxlength="50"></label>
      <label class="l">نبذة<textarea name="bio" rows="3" maxlength="500">${esc(me.bio)}</textarea></label>
      <label class="l">الصورة الشخصية<input type="file" name="avatar" accept="image/jpeg,image/png,image/webp"></label>
      <div class="err" id="err"></div><button class="btn">حفظ</button>
    </form>`);
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target); if (!fd.get('avatar').size) fd.delete('avatar');
      await api('/me', { method: 'PUT', body: fd }); await boot(); toast('تم الحفظ'); location.hash = '#/artist/' + me.username;
    } catch (x) { $('#err').textContent = x.message; }
  };
};

routes.wallet = async () => {
  if (!me) return needLogin();
  const [w, tx, wd] = await Promise.all([api('/wallet'), api('/wallet/transactions'), api('/withdrawals')]);
  const { wallet, settings: st } = w;
  const typeAr = { earning: 'أرباح', withdrawal: 'سحب', refund: 'إرجاع', deposit: 'إيداع', adjustment: 'تعديل' };
  view(`<h1>المحفظة</h1>
    <div class="stats">
      <div class="stat hl"><div class="l">الرصيد المتاح</div><div class="v">${usd(wallet.available)}</div></div>
      <div class="stat"><div class="l">أرباح معلّقة</div><div class="v">${usd(wallet.pending)}</div><div class="muted small">تصبح متاحة بعد ${st.hold_days} يوم</div></div>
      <div class="stat"><div class="l">إجمالي الأرباح</div><div class="v">${usd(wallet.total_earned)}</div></div>
    </div>
    <div class="panel"><h2 style="margin-top:0">طلب سحب</h2>
      <p class="muted small">الحد الأدنى للسحب ${usd(st.min_withdraw)} · المعدل الحالي ${usd(st.rate_per_1000)} لكل 1000 استماع مؤهل</p>
      <form class="f" id="wf" style="margin-top:10px">
        <label class="l">المبلغ بالدولار<input name="amount_usd" type="number" step="0.01" min="${st.min_withdraw / 1e6}" max="${wallet.available / 1e6}" required></label>
        <label class="l">وسيلة الاستلام<select name="method">${st.methods.map(m => `<option>${esc(m)}</option>`).join('')}</select></label>
        <label class="l">بيانات الاستلام (رقم الهاتف/المحفظة/الحساب)<input name="details" required maxlength="300"></label>
        <div class="err" id="err"></div>
        <button class="btn" id="wb" ${wallet.available < st.min_withdraw ? 'disabled' : ''}>${wallet.available < st.min_withdraw ? 'لم تبلغ الحد الأدنى بعد' : 'اطلب السحب'}</button>
      </form></div>
    <h2>طلبات السحب</h2>
    <div class="panel scroll">${wd.withdrawals.length ? `<table class="tbl"><tr><th>#</th><th>المبلغ</th><th>الوسيلة</th><th>الحالة</th><th>التاريخ</th><th>ملاحظة</th></tr>${wd.withdrawals.map(x => `<tr><td>${x.id}</td><td>${usd(x.amount)}</td><td>${esc(x.method)}</td><td>${badge(x.status)}</td><td>${dt(x.created_at)}</td><td>${esc(x.admin_note)}</td></tr>`).join('')}</table>` : '<div class="empty">لا توجد طلبات</div>'}</div>
    <h2>سجل المعاملات</h2>
    <div class="panel scroll">${tx.transactions.length ? `<table class="tbl"><tr><th>النوع</th><th>المبلغ</th><th>التفاصيل</th><th>التاريخ</th></tr>${tx.transactions.map(x => `<tr><td>${typeAr[x.type] || x.type}</td><td class="${x.amount >= 0 ? 'pos' : 'neg'}">${x.amount >= 0 ? '+' : ''}${usd(x.amount)}</td><td>${esc(x.note)}</td><td>${dt(x.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">لا توجد معاملات</div>'}</div>`);
  const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  $('#wf').onsubmit = async e => {
    e.preventDefault(); $('#wb').disabled = true;
    try {
      const body = Object.fromEntries(new FormData(e.target)); body.idem_key = key;
      await api('/withdrawals', { method: 'POST', body });
      toast('تم إرسال طلب السحب'); routes.wallet(); refreshMe();
    } catch (x) { $('#err').textContent = x.message; $('#wb').disabled = false; }
  };
};

routes.notifications = async () => {
  if (!me) return needLogin();
  const r = await api('/notifications');
  view(`<h1>الإشعارات</h1><div class="panel">${r.notifications.length ? r.notifications.map(n => `<div class="row" style="cursor:default"><div class="grow"><div class="t">${n.is_read ? '' : '<span class="gold">● </span>'}${esc(n.title)}</div><div class="muted small">${esc(n.body)} · ${dt(n.created_at)}</div></div></div>`).join('') : '<div class="empty">لا توجد إشعارات</div>'}</div>`);
  await api('/notifications/read', { method: 'POST' }); unread = 0; renderChrome();
};

/* ---------- لوحة الإدارة ---------- */
routes.admin = async tab => {
  if (!me || me.role !== 'admin') return view('<div class="panel">غير مصرح</div>');
  tab = tab || 'stats';
  const tabs = { stats: 'الإحصاءات', users: 'المستخدمون', songs: 'الأغاني', listens: 'الاستماعات', withdrawals: 'طلبات السحب', transactions: 'المعاملات', settings: 'الإعدادات' };
  const head = `<h1>لوحة الإدارة</h1><div class="tabs">${Object.entries(tabs).map(([k, v]) => `<a href="#/admin/${k}"><button class="${k === tab ? 'on' : ''}">${v}</button></a>`).join('')}</div>`;
  const tbl = (cols, rows) => `<div class="panel scroll"><table class="tbl"><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>${rows.join('')}</table></div>`;
  let body = '';
  if (tab === 'stats') {
    const s = await api('/admin/stats');
    const c = (l, v, hl) => `<div class="stat ${hl ? 'hl' : ''}"><div class="l">${l}</div><div class="v">${v}</div></div>`;
    body = `<div class="stats">${c('المستخدمون', num(s.users))}${c('الأغاني', num(s.songs))}${c('كل الاستماعات', num(s.listens))}${c('استماعات مدفوعة', num(s.paid_listens))}${c('إجمالي الأرباح الموزعة', usd(s.total_earned), 1)}${c('أرصدة متاحة للمستخدمين', usd(s.wallets_available))}${c('أرباح معلقة', usd(s.wallets_pending))}${c('طلبات سحب تنتظر', s.pending_withdrawals, 1)}</div>`;
  } else if (tab === 'users') {
    const r = await api('/admin/users');
    body = tbl(['#', 'المستخدم', 'البريد', 'أغاني', 'متاح', 'معلّق', 'الأرباح', ''], r.users.map(u => `<tr><td>${u.id}</td><td>${esc(u.username)}${u.role === 'admin' ? ' 👑' : ''}</td><td>${esc(u.email)}</td><td>${u.songs}</td><td>${usd(u.available || 0)}</td><td>${usd(u.pending || 0)}</td><td>${usd(u.total_earned || 0)}</td><td>${u.role === 'admin' ? '' : `<button class="btn sm ghost" data-ban="${u.id}">${u.banned ? 'رفع الحظر' : 'حظر'}</button> <button class="btn sm ghost" data-adj="${u.id}">تعديل الرصيد</button>`}</td></tr>`));
  } else if (tab === 'songs') {
    const r = await api('/admin/songs');
    body = tbl(['#', 'الأغنية', 'الفنان', 'الناشر', 'استماعات', 'مؤهلة', 'الحالة', ''], r.songs.map(s => `<tr><td>${s.id}</td><td>${esc(s.title)}</td><td>${esc(s.artist_name)}</td><td>${esc(s.username)}</td><td>${s.plays}</td><td>${s.qualified_plays}</td><td>${badge(s.status)}</td><td><button class="btn sm ghost" data-tg="${s.id}">${s.status === 'published' ? 'إزالة' : 'استعادة'}</button></td></tr>`));
  } else if (tab === 'listens') {
    const r = await api('/admin/listens');
    body = tbl(['#', 'المستمع', 'الأغنية', 'IP', 'الأرباح', 'سبب عدم الدفع', 'الوقت'], r.listens.map(l => `<tr><td>${l.id}</td><td>${esc(l.listener)}</td><td>${esc(l.title)}</td><td>${esc(l.ip)}</td><td>${l.paid_amount ? usd(l.paid_amount) : '—'}</td><td>${esc(l.reason || '')}</td><td>${dt(l.created_at)}</td></tr>`));
  } else if (tab === 'withdrawals') {
    const r = await api('/admin/withdrawals');
    const acts = w => w.status === 'review' ? `<button class="btn sm" data-ws="approved" data-id="${w.id}">قبول</button> <button class="btn sm danger" data-ws="rejected" data-id="${w.id}">رفض</button>`
      : w.status === 'approved' ? `<button class="btn sm" data-ws="completed" data-id="${w.id}">تم التحويل</button> <button class="btn sm danger" data-ws="rejected" data-id="${w.id}">رفض</button>` : '';
    body = tbl(['#', 'المستخدم', 'المبلغ', 'الوسيلة', 'بيانات الاستلام', 'الحالة', 'التاريخ', ''], r.withdrawals.map(w => `<tr><td>${w.id}</td><td>${esc(w.username)}<div class="muted small">${esc(w.email)}</div></td><td>${usd(w.amount)}</td><td>${esc(w.method)}</td><td>${esc(w.details)}</td><td>${badge(w.status)}</td><td>${dt(w.created_at)}</td><td>${acts(w)}</td></tr>`));
  } else if (tab === 'transactions') {
    const r = await api('/admin/transactions');
    body = tbl(['#', 'المستخدم', 'النوع', 'المبلغ', 'التفاصيل', 'الوقت'], r.transactions.map(t => `<tr><td>${t.id}</td><td>${esc(t.username)}</td><td>${esc(t.type)}</td><td class="${t.amount >= 0 ? 'pos' : 'neg'}">${usd(t.amount)}</td><td>${esc(t.note)}</td><td>${dt(t.created_at)}</td></tr>`));
  } else if (tab === 'settings') {
    const { settings: s } = await api('/admin/settings');
    body = `<form class="f panel" id="sf">
      <label class="l">أرباح كل 1000 استماع مؤهل (بالدولار)<input name="rate_per_1000" type="number" step="0.0001" min="0" value="${s.rate_per_1000 / 1e6}"></label>
      <label class="l">الحد الأدنى للسحب (بالدولار)<input name="min_withdraw" type="number" step="0.01" min="0" value="${s.min_withdraw / 1e6}"></label>
      <label class="l">الميزانية الشهرية للأرباح (بالدولار)<input name="monthly_budget" type="number" step="1" min="0" value="${s.monthly_budget / 1e6}"></label>
      <label class="l">مدة تعليق الأرباح (أيام)<input name="hold_days" type="number" min="0" value="${s.hold_days}"></label>
      <label class="l">أقل مدة استماع ليُحتسب (ثوانٍ)<input name="min_listen_seconds" type="number" min="5" value="${s.min_listen_seconds}"></label>
      <label class="l">أقصى استماعات مدفوعة لنفس المستمع/الأغنية يوميًا<input name="max_paid_per_song_day" type="number" min="1" value="${s.max_paid_per_song_day}"></label>
      <label class="l">أقصى استماعات مدفوعة لنفس المستمع يوميًا<input name="max_paid_per_user_day" type="number" min="1" value="${s.max_paid_per_user_day}"></label>
      <label class="l">وسائل السحب (مفصولة بفواصل)<input name="withdraw_methods" value="${esc(s.withdraw_methods)}"></label>
      <div class="err" id="err"></div><button class="btn">حفظ الإعدادات</button></form>`;
  }
  view(head + body);

  const reload = () => routes.admin(tab);
  $$('[data-ban]').forEach(b => b.onclick = async () => { await api(`/admin/users/${b.dataset.ban}/ban`, { method: 'POST' }); reload(); });
  $$('[data-tg]').forEach(b => b.onclick = async () => { await api(`/admin/songs/${b.dataset.tg}/toggle`, { method: 'POST' }); reload(); });
  $$('[data-adj]').forEach(b => b.onclick = async () => {
    const v = prompt('المبلغ بالدولار (موجب للإضافة، سالب للخصم):'); if (!v) return;
    try { await api('/admin/adjust', { method: 'POST', body: { user_id: b.dataset.adj, amount_usd: v, note: prompt('ملاحظة:') || '' } }); toast('تم'); reload(); } catch (x) { toast(x.message); }
  });
  $$('[data-ws]').forEach(b => b.onclick = async () => {
    const st = b.dataset.ws; const note = st === 'rejected' ? prompt('سبب الرفض:') : '';
    if (st === 'rejected' && note === null) return;
    try { await api(`/admin/withdrawals/${b.dataset.id}/status`, { method: 'POST', body: { status: st, note } }); reload(); } catch (x) { toast(x.message); }
  });
  const sf = $('#sf');
  if (sf) sf.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(sf));
    for (const k of ['rate_per_1000', 'min_withdraw', 'monthly_budget']) f[k] = Math.round(Number(f[k]) * 1e6);
    try { await api('/admin/settings', { method: 'PUT', body: f }); toast('تم حفظ الإعدادات'); } catch (x) { $('#err').textContent = x.message; }
  };
};

/* ---------- الإطار العام والتوجيه ---------- */
function renderChrome() {
  const links = [['#/', '🏠', 'الرئيسية'], ['#/library', '♥', 'المفضلة'], ['#/upload', '⬆', 'نشر أغنية'], ['#/wallet', '💳', 'المحفظة']];
  if (me) links.push([`#/artist/${me.username}`, '🎤', 'صفحتي'], ['#/notifications', '🔔', `الإشعارات${unread ? ' (' + unread + ')' : ''}`]);
  if (me && me.role === 'admin') links.push(['#/admin', '⚙', 'الإدارة']);
  const cur = location.hash || '#/';
  $('#nav').innerHTML = links.map(([h, i, t]) => `<a href="${h}" class="${cur === h || (h !== '#/' && cur.startsWith(h)) ? 'on' : ''}"><span>${i}</span><span>${t}</span></a>`).join('');
  $('#userbox').innerHTML = me
    ? `<a href="#/profile" class="btn ghost sm">${esc(me.display_name)}</a><button class="btn ghost sm" id="logout">خروج</button>`
    : `<a href="#/login" class="btn ghost sm">دخول</a><a href="#/register" class="btn sm">حساب جديد</a>`;
  const lo = $('#logout');
  if (lo) lo.onclick = async () => { await api('/auth/logout', { method: 'POST' }); me = null; audio.pause(); renderChrome(); location.hash = '#/'; route(); };
}

async function route() {
  const [, name = 'home', arg] = (location.hash || '#/').replace('#', '').split('/');
  renderChrome();
  const key = name || 'home';
  try { await (routes[key] || routes.home)(arg); } catch (e) { view(`<div class="panel err">${esc(e.message)}</div>`); }
}
window.addEventListener('hashchange', route);

/* البحث المباشر */
let st;
const qi = $('#q'), sg = $('#suggest');
qi.addEventListener('input', () => {
  clearTimeout(st);
  const q = qi.value.trim();
  if (!q) { sg.hidden = true; return; }
  st = setTimeout(async () => {
    const r = await api('/search?q=' + encodeURIComponent(q)).catch(() => null);
    if (!r) return;
    const items = [
      ...r.artists.slice(0, 3).map(a => `<a href="#/artist/${esc(a.username)}">🎤 ${esc(a.display_name)}</a>`),
      ...r.songs.slice(0, 5).map(s => `<a href="#/search/${encodeURIComponent(q)}" data-sid="${s.id}">♪ ${esc(s.title)} <span class="muted small">— ${esc(s.artist_name)}</span></a>`),
    ];
    sg.innerHTML = items.join('') || '<div class="empty small">لا توجد نتائج</div>'; sg.hidden = false;
    $$('[data-sid]', sg).forEach((a, i) => a.addEventListener('click', e => { e.preventDefault(); playQueue(r.songs, i); sg.hidden = true; }));
  }, 250);
});
qi.addEventListener('keydown', e => { if (e.key === 'Enter' && qi.value.trim()) { sg.hidden = true; location.hash = '#/search/' + encodeURIComponent(qi.value.trim()); } });
document.addEventListener('click', e => { if (!e.target.closest('.search')) sg.hidden = true; });
sg.addEventListener('click', e => { if (e.target.closest('a:not([data-sid])')) sg.hidden = true; });

async function refreshMe() { const r = await api('/me'); me = r.user; unread = r.unread || 0; renderChrome(); }
async function boot() { await refreshMe(); }

(async () => { await boot(); route(); setInterval(() => me && refreshMe().catch(() => {}), 60000); })();

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
