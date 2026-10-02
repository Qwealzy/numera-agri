// The insurer console: read-only. It reads four GET endpoints under /api/v1
// (the policy list, one policy, the payout list, one payout) with the API key
// the insurer pastes. The key is kept in sessionStorage only, is sent only as
// the x-api-key header, and never goes into a URL. Every value the API returns
// reaches the page through textContent, never as markup. Nothing here writes:
// reporting a settlement or closing a payout stays on the API itself.
(() => {
  'use strict';

  const KEY_SLOT = 'numera.konsol.apiKey';
  const POLICY_PAGE = 50;
  const PAYOUT_PAGE = 200;
  // The payout list has no policy filter, so it is walked to its end and
  // grouped by policy here. Past this many pages the walk stops, and the page
  // says so rather than showing a partial list as the whole.
  const PAYOUT_MAX_PAGES = 50;
  const TZ = 'Europe/Istanbul';

  // --- labels -----------------------------------------------------------------
  // Each code stays on the page, beside its label or as its pill's title, so a
  // label never stands in for the value the API returned.
  const POLICY_STATUS = {
    pending_mint: ['Deftere yazılmayı bekliyor', 'info'],
    active: ['Yürürlükte', 'ok'],
    partially_paid: ['Yürürlükte, limit kısmen kullanıldı', 'ok'],
    manual_review: ['İncelemede', 'warn'],
    expired: ['Süresi doldu', ''],
    cancelled: ['İptal edildi', ''],
    claimed_and_closed: ['Limit tükendi, kapandı', ''],
    grace_period: ['Ek süre (eski kayıt)', 'warn'],
    suspended: ['Askıda (eski kayıt)', 'warn'],
  };
  const DEFAULT_STATE = {
    none: ['Prim temerrüdü yok', 'ok'],
    grace_period: ['Prim: ihtar süresi işliyor', 'warn'],
    suspended: ['Askıda (eski kayıt)', 'warn'],
    terminated: ['Prim: sözleşme sona erdi', 'bad'],
    first_premium_unpaid: ['İlk prim ödenmedi', 'warn'],
    withdrawn_for_first_premium: ['İlk prim nedeniyle cayıldı', 'bad'],
    two_notice_elected: ['İki ihtar yolu seçildi', 'warn'],
    two_notice_terminated: ['İki ihtarla feshedildi', 'bad'],
  };
  const EVENT_TYPE = {
    activation: 'Aktivasyon',
    trigger: 'Tetikleme',
    settlement: 'Ödeme sonucu bildirimi',
    expiry: 'Süre sonu',
    notice: 'İhtar',
    suspension: 'Askıya alma',
    termination: 'Fesih',
    termination_archive: 'Fesih kaydı',
    reinstatement: 'Yeniden yürürlük',
    endorsement: 'Zeyilname',
    renewal: 'Yenileme',
    release: 'Yalnız kanıt kaydı (uygulanmadı)',
    premium_due_date: 'Prim vadesi',
    enforcement_commenced: 'Prim alacağının dava veya takip yoluyla istenmesi',
    first_premium_paid: 'İlk prim ödendi bildirimi',
    first_premium_withdrawal: 'İlk prim nedeniyle cayma',
    first_premium_deemed_withdrawal: 'İlk prim nedeniyle sözleşmeden cayılmış olunması',
    two_notice_election: 'İki defa ihtar nedeniyle fesih',
    two_notice_termination: 'Feshin sigorta döneminin sonunda hüküm doğurması',
    mortgagee_notice: 'İpotekli alacaklıya bildirim',
    mortgagee_election: 'İpotekli alacaklının seçimi',
    mortgagee_info_request: 'İpotekli alacaklının (sınırlı ayni hak sahibi) bilgi istemi',
    mortgagee_info_provided: 'İpotekli alacaklıya (sınırlı ayni hak sahibi) bilgi verilmesi',
    enforcement_fruitless: 'Prim borcu için dava veya takibin semeresiz kalması',
    substitution_notice: 'Semeresiz dava veya takibin sigortalıya bildirilmesi',
    substitution: 'Sigorta ettiren değişikliği',
    attachment: 'Haciz',
    attachment_lifted: 'Haczin kaldırılması',
  };
  // m. 1431(4) says "takip"; the platform records ER_Takip or ER_Dava. A row
  // whose route is known is headed by it; any other keeps EVENT_TYPE's
  // heading, which names both.
  const ENFORCEMENT_ROUTE_HEADING = {
    enforcement_fruitless: {
      ER_Takip: 'Prim borcu için takibin semeresiz kalması',
      ER_Dava: 'Prim borcu için davanın semeresiz kalması',
    },
    substitution_notice: {
      ER_Takip: 'Semeresiz takibin sigortalıya bildirilmesi',
      ER_Dava: 'Semeresiz davanın sigortalıya bildirilmesi',
    },
  };
  const EVENT_STATUS = {
    pending: ['Sırada', ''],
    processing: ['İşleniyor', 'info'],
    done: ['Tamamlandı', 'ok'],
    failed: ['Başarısız', 'bad'],
  };
  const FAILURE = {
    insurer_party_not_allocated: 'Sigortacının defter tarafı henüz yok; kayıt tamamlanmamış.',
    oracle_party_not_configured: 'Sigortacı için ölçüm operatörü tanımlı değil; poliçe onsuz deftere yazılmaz.',
    oracle_party_is_insurer: 'Sigortacı kendi ölçüm operatörü olarak tanımlanmış; poliçe bu şekilde deftere yazılmaz.',
    grace_period_not_configured: 'Poliçe ya da sigortacı için ek süre tanımlı değil.',
    grace_period_below_statutory_minimum: 'Tanımlı ek süre, kanuni ihtar süresinden kısa.',
    retroactive_cover_check_refused: 'Geriye dönük teminat penceresinde bir ödeme kademesine uyan okuma var; kayıt reddedildi.',
    retroactive_cover_check_no_cells: 'Poliçe geriye dönük ama hücre içermiyor; geriye dönük teminat kontrolü çalışamaz.',
    cover_not_begun: 'Teminat başlamamış: ilk prim ödemesi ya da kararlaştırılmış başlangıç kaydı yok.',
    mortgagee_continuation_not_configured: 'Poliçede ipotekli alacaklı var ama poliçe deftere yazılırken sigortacı için devam süresi tanımlı değildi.',
    first_premium_withdrawal_window_not_configured: 'Poliçe deftere yazılırken sigortacı için ilk prim cayma süresi tanımlı değildi.',
    internal_or_ledger_error: 'İstek tamamlanamadı. Olay kimliğini platform operatörüne iletin.',
  };
  const PAYOUT_STATUS = {
    approved: ['Onaylandı, ödeme sonucu bekleniyor', 'info'],
    manual_review: ['İncelemede', 'warn'],
    settled: ['Sigortacı ödemeyi bildirdi', 'ok'],
    closed_unpaid: ['Ödenmeden kapatıldı', ''],
  };
  const RECORD_KIND = {
    payout: 'Ödeme talimatı',
    unrouted_remainder: 'Yönlendirilmemiş kalan',
    unrouted_competing_claims: 'Çakışan talepler, yönlendirilmedi',
  };
  const RECIPIENT = {
    PDR_Insured: 'Sigortalı',
    PDR_Mortgagee: 'İpotekli alacaklı (sınırlı ayni hak sahibi)',
    PDR_Beneficiary: 'Lehtar',
    PDR_EnforcementOffice: 'İcra müdürlüğü',
  };
  const NOTIFICATION_TYPE = {
    'payout.approved': 'Onay bildirimi',
    'payout.review_required': 'İnceleme bildirimi',
  };
  const NOTIFICATION_STATUS = {
    pending: ['Sırada', ''],
    processing: ['Gönderiliyor', 'info'],
    delivered: ['İletildi', 'ok'],
    failed: ['İletilemedi', 'bad'],
  };

  // --- small helpers ---------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  // Builds an element; strings become text nodes, never markup.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (name === 'className') node.className = value;
      else if (name === 'text') node.textContent = value;
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function pill(map, code) {
    const [label, tone] = map[code] ?? [code, ''];
    return el('span', { className: `pill ${tone}`.trim(), title: code }, label);
  }

  // defaultState sona ermiş bir sözleşmeyi
  // gösterirken (terminated, ilk primin ödenmemesi yüzünden cayma, ya da iki
  // ihtarla fesih) 'active' ve 'cancelled' rozetleri etiketsiz ve tonsuz kalır,
  // yalnız ham kodu gösterir; 'partially_paid' rozeti "Yürürlükte, " önekini
  // düşer, "Limit kısmen kullanıldı" nötr tonla kalır. 'claimed_and_closed' ve
  // 'expired' etiketli kalır: sona erme sonrası açık payout beklerken de
  // meşrudur (handleTermination archive, açık payout_events sayar). Başka bir
  // defaultState'te her rozet bugünkü gibi değişmeden kalır.
  function statusPill(status, defaultState) {
    const contractEnded = defaultState === 'terminated'
      || defaultState === 'withdrawn_for_first_premium'
      || defaultState === 'two_notice_terminated';
    if (contractEnded) {
      if (status === 'active' || status === 'cancelled') return [status, ''];
      if (status === 'partially_paid') return ['Limit kısmen kullanıldı', ''];
    }
    return POLICY_STATUS[status] ?? [status, ''];
  }

  function policyStatusPill(status, defaultState) {
    const [label, tone] = statusPill(status, defaultState);
    return el('span', { className: `pill ${tone}`.trim(), title: status }, label);
  }

  function codeBeside(label, code) {
    return el('span', null, label, label === code ? null : el('span', { className: 'mono soft' }, ` · ${code}`));
  }

  // Decimal text as the API sends it ("12345.50", "25.0000000000"), grouped the
  // Turkish way. Never through Number(): the digits are shown as sent.
  function formatDecimal(text, minFraction) {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text));
    if (!m) return String(text);
    const [, sign, whole, fractionIn = ''] = m;
    let fraction = fractionIn.replace(/0+$/, '');
    if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, '0');
    return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (fraction ? `,${fraction}` : '');
  }
  const money = (amount, currency) => `${formatDecimal(amount, 2)} ${currency}`;
  const percent = (value) => `%${formatDecimal(value, 0)}`;

  // Sums decimal texts exactly, in BigInt, and returns decimal text.
  function sumDecimals(values) {
    const parts = values.map((v) => /^(\d+)(?:\.(\d+))?$/.exec(String(v)));
    if (parts.some((p) => !p)) return null;
    const scale = Math.max(0, ...parts.map((p) => (p[2] ?? '').length));
    let total = 0n;
    for (const p of parts) total += BigInt(p[1] + (p[2] ?? '').padEnd(scale, '0'));
    const digits = total.toString().padStart(scale + 1, '0');
    return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }

  function totalsByCurrency(payouts) {
    const byCurrency = new Map();
    for (const p of payouts) {
      if (!byCurrency.has(p.currency)) byCurrency.set(p.currency, []);
      byCurrency.get(p.currency).push(p.amount);
    }
    return [...byCurrency].map(([currency, amounts]) => {
      const sum = sumDecimals(amounts);
      return sum === null ? `${currency}: toplanamadı` : money(sum, currency);
    }).join(' · ');
  }

  const instantFormat = new Intl.DateTimeFormat('tr-TR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const instant = (iso) => (iso ? instantFormat.format(new Date(iso)) : null);
  const dayFormat = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
  const dayOf = (iso) => (iso ? dayFormat.format(new Date(iso)) : null);
  // A calendar day as the API sends it, YYYY-MM-DD; never through a Date,
  // which would place it at a midnight in some zone.
  const day = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(ymd);
  };
  const shortId = (id) => String(id).slice(0, 8);

  // --- the key ---------------------------------------------------------------
  let memoryKey = null;
  let storageRefused = false;

  function readKey() {
    if (memoryKey) return memoryKey;
    try {
      return sessionStorage.getItem(KEY_SLOT);
    } catch {
      storageRefused = true;
      return null;
    }
  }

  function storeKey(key) {
    memoryKey = key;
    try {
      sessionStorage.setItem(KEY_SLOT, key);
    } catch {
      // Kept in this page's memory only; the page says so below.
      storageRefused = true;
    }
  }

  function forgetKey() {
    memoryKey = null;
    try {
      sessionStorage.removeItem(KEY_SLOT);
    } catch {
      storageRefused = true;
    }
  }

  // --- the API ---------------------------------------------------------------
  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, key = readKey()) {
    if (!key) throw new ApiError(401, 'anahtar yok');
    let res;
    try {
      res = await fetch(`/api/v1${path}`, {
        headers: { 'x-api-key': key, Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (err) {
      throw new ApiError(0, err.message);
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      throw new ApiError(res.status, body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
    }
    if (body === null) throw new ApiError(res.status, 'yanıt JSON değil');
    return body;
  }

  // A fixed Turkish sentence for each kind of failure; what the API (or, with
  // no response, the browser) said stays beside it in mono.
  const describe = (err) => {
    if (!(err instanceof ApiError)) return `Beklenmeyen hata: ${err.message}`;
    const sentence =
      err.status === 0 ? 'Sunucuya ulaşılamadı.'
        : err.status === 400 ? 'Sunucu isteği geçersiz buldu.'
        : err.status === 404 ? 'İstenen kayıt bulunamadı.'
        : err.status >= 500 ? "Sunucuda bir hata oluştu. Birkaç dakika sonra Yenile'ye basın; sürerse operatöre bildirin."
        : 'İstek başarısız.';
    const said = err.status === 0 || err.message === `HTTP ${err.status}` ? err.message : `HTTP ${err.status}: ${err.message}`;
    return [sentence, ' ', el('span', { className: 'mono' }, `(${said})`)];
  };

  // --- state -----------------------------------------------------------------
  const state = {
    policies: [],
    nextCursor: null,
    payouts: [],
    payoutsByPolicy: new Map(),
    payoutsTruncated: false,
    // 'loading' until the payout walk of the current load ends, then 'ready'
    // or 'failed'; until 'ready' the payout parts of the page say so instead
    // of showing what payouts holds.
    payoutsStatus: 'loading',
    payoutsError: null,
    selected: null,
    detailToken: 0,
    loadToken: 0,
  };

  // A list load reads the key once, at its start, and carries the load token
  // current then. Once the token has moved on (a newer load began, or reset()
  // ran) the load sends no further request and changes nothing on the page.
  async function loadPolicies(reset, load) {
    const cursor = reset ? null : state.nextCursor;
    const page = await api(`/policies?limit=${POLICY_PAGE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, load.key);
    if (load.token !== state.loadToken) return;
    // "More" extends only the list its cursor came from; a refresh that
    // finished in the meantime has replaced that list.
    if (!reset && state.nextCursor !== cursor) return;
    if (reset) state.policies = [];
    state.policies.push(...page.items);
    state.nextCursor = page.nextCursor;
  }

  async function loadPayouts(load) {
    const all = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await api(`/payouts?limit=${PAYOUT_PAGE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, load.key);
      if (load.token !== state.loadToken) return;
      all.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < PAYOUT_MAX_PAGES);
    state.payouts = all;
    state.payoutsTruncated = cursor !== null;
    state.payoutsByPolicy = new Map();
    // The list is oldest first; each policy's payouts are shown newest first.
    for (const payout of [...all].reverse()) {
      if (!state.payoutsByPolicy.has(payout.policyId)) state.payoutsByPolicy.set(payout.policyId, []);
      state.payoutsByPolicy.get(payout.policyId).push(payout);
    }
  }

  // --- screens ---------------------------------------------------------------
  function showGate(message) {
    $('app').hidden = true;
    $('session').hidden = true;
    $('gate').hidden = false;
    $('gate-error').hidden = !message;
    $('gate-error').textContent = message ?? '';
    $('key-input').focus();
  }

  function showApp() {
    $('gate').hidden = true;
    $('app').hidden = false;
    $('session').hidden = false;
    if (storageRefused) document.querySelector('#session .who').textContent = 'Anahtar yalnızca bu sayfa açıkken bellekte';
  }

  function listError(message) {
    $('list-error').hidden = !message;
    $('list-error').replaceChildren(...[message ?? ''].flat());
  }

  function failed(err) {
    if (err instanceof ApiError && err.status === 401) {
      forgetKey();
      showGate('Anahtar tanınmadı ya da etkin değil (HTTP 401). Anahtarı kontrol edip yeniden girin.');
      return;
    }
    listError(describe(err));
  }

  async function start() {
    const load = { token: ++state.loadToken, key: readKey() };
    showApp();
    listError(null);
    $('refresh').disabled = true;
    state.payoutsStatus = 'loading';
    state.payoutsError = null;
    // The payout walk runs beside the policy read; the list is drawn without
    // waiting for it, and a payout read that fails marks only the payout parts.
    const payoutsRead = loadPayouts(load).then(() => null, (err) => err);
    let policiesFailed = false;
    try {
      await loadPolicies(true, load);
    } catch (err) {
      if (load.token !== state.loadToken) return;
      failed(err);
      $('refresh').disabled = false;
      if (err instanceof ApiError && err.status === 401) return;
      // The rows of the previous load stay on screen; the payout walk below
      // still settles the payout status for them.
      policiesFailed = true;
    }
    if (load.token !== state.loadToken) return;
    if (!policiesFailed) {
      renderKpis();
      renderList();
    }
    const payoutsErr = await payoutsRead;
    if (load.token !== state.loadToken) return;
    $('refresh').disabled = false;
    if (payoutsErr instanceof ApiError && payoutsErr.status === 401) {
      failed(payoutsErr);
      return;
    }
    state.payoutsStatus = payoutsErr ? 'failed' : 'ready';
    state.payoutsError = payoutsErr;
    renderKpis(!policiesFailed);
    if (state.selected) await selectPolicy(state.selected, false);
  }

  // policiesRead false: the policy read of this load failed, so the policy
  // tiles keep what they showed and only the payout parts are drawn.
  function renderKpis(policiesRead = true) {
    if (policiesRead) {
      $('kpi-policies').textContent = `${state.policies.length}${state.nextCursor ? '+' : ''}`;
      $('kpi-policies-sub').textContent = state.nextCursor ? 'Yüklenenler; listede daha fazlası var' : 'Tümü yüklendi';
    }

    const payoutsReady = state.payoutsStatus === 'ready';
    const payoutsPending = state.payoutsStatus === 'failed' ? 'Ödeme bilgisi okunamadı' : 'Ödemeler okunuyor…';
    const approved = state.payouts.filter((p) => p.status === 'approved' && p.recordKind === 'payout');
    $('kpi-approved').textContent = payoutsReady ? String(approved.length) : '–';
    $('kpi-approved-sub').textContent = !payoutsReady ? payoutsPending : approved.length ? totalsByCurrency(approved) : 'Bekleyen yok';

    const review = state.payouts.filter((p) => p.status === 'manual_review');
    $('kpi-review').textContent = payoutsReady ? String(review.length) : '–';
    $('kpi-review-sub').textContent = !payoutsReady ? payoutsPending : review.length ? totalsByCurrency(review) : 'İncelemede kalem yok';

    if (policiesRead) {
      const failedPolicies = state.policies.filter((p) => p.lastEvent && p.lastEvent.status === 'failed');
      $('kpi-failed').textContent = String(failedPolicies.length);
      $('kpi-failed-sub').textContent = 'Yüklenen poliçeler arasında';
    }

    const warning = $('payouts-warning');
    const notes = [];
    if (state.payoutsStatus === 'failed') {
      notes.push([policiesRead ? 'Ödeme bilgisi okunamadı; poliçe listesi gösteriliyor, ödeme sayıları ve poliçe ayrıntısındaki ödemeler gösterilemiyor.' : 'Ödeme bilgisi okunamadı; ödeme sayıları ve poliçe ayrıntısındaki ödemeler gösterilemiyor.', ' ', describe(state.payoutsError)]);
    }
    if (payoutsReady && state.payoutsTruncated) {
      notes.push(`Ödeme listesi ${PAYOUT_MAX_PAGES * PAYOUT_PAGE} kayıtta durduruldu; sayılar ve poliçe ayrıntısındaki ödemeler eksik olabilir.`);
    }
    if (storageRefused) notes.push('Tarayıcı oturum belleğine izin vermedi; anahtar yalnızca bu sayfa açıkken bellekte tutuluyor.');
    warning.hidden = notes.length === 0;
    warning.replaceChildren(...notes.flatMap((note, i) => [i ? ' ' : '', note].flat(2)));
  }

  function remainingLines(summary) {
    if (summary.coverages.length === 0) return [el('span', { className: 'soft' }, 'Teminat yok')];
    const lines = summary.coverages.slice(0, 2).map((c) =>
      el('div', { className: 'num' },
        el('div', { className: 'cell-main nowrap' }, money(c.remainingLimit, summary.currency)),
        el('div', { className: 'cell-sub' }, `${c.coverageCode} · bedel ${formatDecimal(c.sumInsured, 2)}`)));
    if (summary.coverages.length > 2) lines.push(el('div', { className: 'cell-sub' }, `+${summary.coverages.length - 2} teminat`));
    return lines;
  }

  function lastEventCell(summary) {
    const e = summary.lastEvent;
    if (!e) return [el('span', { className: 'soft' }, 'İşlem kaydı yok')];
    return [
      el('div', { className: 'pills' }, pill(EVENT_STATUS, e.status)),
      el('div', { className: 'cell-sub' }, `${eventHeading(e)} · ${instant(e.createdAt)}`),
    ];
  }

  function renderList() {
    const rows = $('policy-rows');
    rows.replaceChildren();
    // Each cell's content sits in ONE div: at phone width a cell is a
    // two-column grid, its label and its content.
    const cell = (label, ...content) => el('td', { 'data-label': label }, el('div', null, ...content));
    for (const summary of state.policies) {
      const products = [...new Set(summary.coverages.map((c) => c.productCode))];
      const row = el('tr', {
        className: 'row',
        tabindex: '0',
        'aria-selected': String(summary.policyId === state.selected),
        'data-id': summary.policyId,
      },
      cell('Poliçe',
        el('div', { className: 'cell-main mono' }, shortId(summary.policyId)),
        el('div', { className: 'cell-sub' }, products.join(', ') || 'Teminat yok')),
      cell('Durum',
        el('div', { className: 'pills' },
          policyStatusPill(summary.status, summary.defaultState),
          summary.defaultState === 'none' ? null : pill(DEFAULT_STATE, summary.defaultState))),
      cell('Dönem',
        el('div', { className: 'num nowrap' }, `${day(summary.startDate)} – ${day(summary.endDate)}`),
        el('div', { className: 'cell-sub' },
          summary.coverageBegun ? `Teminat başladı: ${dayOf(summary.coverageBeganAt)}` : 'Teminat başlamadı')),
      cell('Kalan limit', remainingLines(summary)),
      cell('Son işlem', lastEventCell(summary)));
      row.addEventListener('click', () => selectPolicy(summary.policyId, true));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectPolicy(summary.policyId, true);
        }
      });
      rows.append(row);
    }
    $('policy-table').hidden = state.policies.length === 0;
    $('list-empty').hidden = state.policies.length !== 0;
    $('list-foot').hidden = !state.nextCursor;
    $('list-meta').textContent = `${state.policies.length} poliçe · en yeni önce`;
  }

  // --- the detail pane -------------------------------------------------------
  function factsGrid(pairs) {
    return el('dl', { className: 'facts-grid' },
      pairs.map(([term, value]) => el('div', null, el('dt', null, term), el('dd', null, value))));
  }

  function kv(pairs) {
    return el('div', { className: 'kv' }, pairs.flatMap(([k, v]) => [el('span', null, k), el('span', null, v)]));
  }

  function coverageCard(coverage, currency) {
    const sum = Number(coverage.sumInsured);
    const remaining = Number(coverage.remainingLimit);
    // For the bar only; the figures beside it are the decimal text.
    const share = sum > 0 ? Math.max(0, Math.min(100, (remaining / sum) * 100)) : 0;
    const bar = el('div', { className: 'bar', role: 'img', 'aria-label': `Kalan limit oranı %${Math.round(share)}` }, el('span'));
    bar.firstChild.style.width = `${share}%`;
    return el('div', { className: 'cov' },
      el('div', { className: 'cov-head' },
        el('strong', null, coverage.coverageCode),
        el('span', { className: 'soft' }, `${coverage.productCode} · ${coverage.perilType}`)),
      kv([
        ['Sigorta bedeli', money(coverage.sumInsured, currency)],
        ['Kalan limit', money(coverage.remainingLimit, currency)],
      ]),
      bar);
  }

  function settlementText(p) {
    if (p.status === 'settled') {
      return `Sigortacı ödemeyi bildirdi; bildirilen ödeme tarihi ${instant(p.settledAt) ?? 'kayıtlı değil'}`;
    }
    if (p.status === 'closed_unpaid') {
      return `Ödenmeden kapatıldı; bildirilen kapanış ${instant(p.closedAt) ?? 'kayıtlı değil'}`;
    }
    if (p.status === 'manual_review') return 'İncelemede; sigortacının sonuç bildirimi bekleniyor';
    return 'Sigortacının ödeme sonucu bildirimi bekleniyor';
  }

  function notificationLines(p) {
    if (p.notifications.length === 0) return 'Bildirim kaydı yok';
    return el('div', { className: 'pills' }, p.notifications.map((n) => {
      const [label, tone] = NOTIFICATION_STATUS[n.status] ?? [n.status, ''];
      const when = n.deliveredAt ? ` ${instant(n.deliveredAt)}` : '';
      return el('span', { className: `pill ${tone}`.trim(), title: `${n.type} · ${n.status}` },
        `${NOTIFICATION_TYPE[n.type] ?? n.type}: ${label}${when}`);
    }));
  }

  // resolutionRecordContractId is permanently null on a payout resolved
  // before this value was kept (openapi.json), so a settled/closed_unpaid
  // record with no id was never going to get one, unlike a still-open one.
  function resolutionRecordLabel(record) {
    if (record.resolutionRecordContractId) return el('span', { className: 'mono' }, record.resolutionRecordContractId);
    return ['settled', 'closed_unpaid'].includes(record.status) ? 'Kayıtlı değil' : 'Henüz yok';
  }

  function fullRecord(record) {
    return kv([
      ['Ödeme kimliği', el('span', { className: 'mono' }, record.payoutId)],
      [record.recordKind === 'payout' ? 'Onay anı (defter)' : 'İncelemeye alındığı an (defter)', instant(record.approvedAt) ?? 'Kayıtlı değil'],
      ['Kayıt oluşturuldu', instant(record.createdAt)],
      ['Kapanış kaydı', instant(record.resolvedAt) ?? 'Henüz yok'],
      ['Kanıt özeti', record.evidenceDigest ? el('span', { className: 'mono' }, record.evidenceDigest) : 'Kayıtlı değil'],
      ['Defter kaydı', record.ledgerContractId ? el('span', { className: 'mono' }, record.ledgerContractId) : 'Yok'],
      ['Sonuç kaydı', resolutionRecordLabel(record)],
      ['Bu tetiklemeyle poliçe limiti tükendi mi', record.isFullSettlement ? 'Evet' : 'Hayır'],
    ]);
  }

  function payoutCard(p) {
    const more = el('details', { className: 'more' }, el('summary', null, 'Kaydın tamamı'));
    const moreBody = el('div', null, el('span', { className: 'soft' }, 'Açıldığında güncel kayıt okunur.'));
    more.append(moreBody);
    more.addEventListener('toggle', async () => {
      if (!more.open || more.dataset.loaded === 'true') return;
      moreBody.replaceChildren(el('span', { className: 'soft' }, 'Okunuyor…'));
      try {
        const record = await api(`/payouts/${encodeURIComponent(p.payoutId)}`);
        more.dataset.loaded = 'true';
        moreBody.replaceChildren(fullRecord(record),
          el('div', { className: 'cell-sub' }, `Okundu: ${instant(new Date().toISOString())}`));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return failed(err);
        moreBody.replaceChildren(el('p', { className: 'alert', role: 'alert' }, describe(err)));
      }
    });

    const tier = [percent(p.payoutPercentage), p.tierLabel ? `kademe: ${p.tierLabel}` : null, `teminat ${p.coverageCode}`]
      .filter(Boolean).join(' · ');
    return el('article', { className: 'payout' },
      el('div', { className: 'payout-head' },
        el('div', null,
          el('div', { className: 'amount' }, money(p.amount, p.currency)),
          el('div', { className: 'cell-sub' }, tier)),
        el('div', { className: 'pills' },
          pill(PAYOUT_STATUS, p.status),
          p.recordKind === 'payout' ? null : el('span', { className: 'pill warn', title: p.recordKind }, RECORD_KIND[p.recordKind] ?? p.recordKind))),
      kv([
        ['Alıcı rolü', p.recipientRole ? codeBeside(RECIPIENT[p.recipientRole] ?? p.recipientRole, p.recipientRole) : 'Yönlendirilmedi'],
        ['Olay', p.eventStart ? `${instant(p.eventStart)} – ${instant(p.eventEnd)}` : 'Kayıtlı değil'],
        ['Bildirim', notificationLines(p)],
        ['Ödeme durumu', settlementText(p)],
      ]),
      more);
  }

  // record.enforcementRoute is the route of the policy's latest recorded
  // fruitless enforcement: the newest done enforcement_fruitless row, and the
  // substitution notice that follows it. Events are newest first, so a row
  // with a done enforcement_fruitless above it follows a later record.
  function eventHeading(e, record) {
    const byRoute = ENFORCEMENT_ROUTE_HEADING[e.eventType];
    if (!byRoute || !record || !record.enforcementRoute) return EVENT_TYPE[e.eventType] ?? e.eventType;
    const at = record.events.findIndex((x) => x.eventId === e.eventId);
    const replaced = record.events.slice(0, at).some((x) => x.eventType === 'enforcement_fruitless' && x.status === 'done');
    const known = at !== -1 && !replaced && (e.eventType !== 'enforcement_fruitless' || e.status === 'done');
    return (known && byRoute[record.enforcementRoute]) || EVENT_TYPE[e.eventType];
  }

  function eventItem(e, record) {
    const [statusLabel] = EVENT_STATUS[e.status] ?? [e.status];
    return el('li', null,
      el('div', null,
        el('div', null, codeBeside(eventHeading(e, record), e.eventType)),
        el('div', { className: 'cell-sub' },
          `Kuyruğa alındı ${instant(e.createdAt)}${e.processedAt ? ` · işlendi ${instant(e.processedAt)}` : ''} · olay ${shortId(e.eventId)}`)),
      el('div', { title: statusLabel }, pill(EVENT_STATUS, e.status)),
      e.failure
        ? el('div', { className: 'failure' }, `${FAILURE[e.failure.code] ?? e.failure.message} `, el('span', { className: 'mono' }, `(${e.failure.code})`))
        : null);
  }

  // onLedger goes false again once the token is archived without a re-mint
  // (expired, cancelled, claimed_and_closed), not only before the first
  // mint (policyRecord.js), so those three read as archived, not pending.
  function ledgerRecordLabel(record) {
    if (record.onLedger) return 'Var';
    return ['expired', 'cancelled', 'claimed_and_closed'].includes(record.status) ? 'Arşivlendi' : 'Henüz yok';
  }

  function renderDetail(record) {
    const payouts = state.payoutsByPolicy.get(record.policyId) ?? [];
    const payoutsReady = state.payoutsStatus === 'ready';
    const body = $('detail-body');
    body.replaceChildren(
      el('div', { className: 'pane-head' },
        el('div', { className: 'detail-title' },
          el('h2', null, `Poliçe ${shortId(record.policyId)}`),
          el('span', { className: 'mono' }, record.policyId),
          el('div', { className: 'pills' },
            policyStatusPill(record.status, record.defaultState),
            pill(DEFAULT_STATE, record.defaultState))),
        el('button', { className: 'btn light back', type: 'button', id: 'back' }, 'Listeye dön')),
      el('div', { className: 'pane-body' },
        factsGrid([
          ['Dönem', `${day(record.startDate)} – ${day(record.endDate)}`],
          ['Dönem başlangıç ve bitiş saati', record.termStart ? `${instant(record.termStart)} – ${instant(record.expiry)}` : 'Deftere yazılınca belirlenir'],
          ['Teminat başlangıcı', record.coverageBegun ? instant(record.coverageBeganAt) : 'Başlamadı'],
          ['Defterde kaydı', ledgerRecordLabel(record)],
        ]),
        el('h3', { className: 'section' }, `Teminatlar (${record.coverages.length})`),
        record.coverages.length
          ? record.coverages.map((c) => coverageCard(c, currencyOf(record.policyId)))
          : el('div', { className: 'empty' }, 'Bu poliçede teminat yok.'),
        el('h3', { className: 'section' }, payoutsReady ? `Ödeme kayıtları (${payouts.length})` : 'Ödeme kayıtları'),
        payoutsReady && state.payoutsTruncated
          ? el('p', { className: 'alert warn' }, 'Ödeme listesi sonuna kadar okunamadı; bu poliçenin ödemeleri eksik olabilir.')
          : null,
        !payoutsReady
          ? el('div', { className: 'empty' }, state.payoutsStatus === 'failed' ? 'Ödeme bilgisi okunamadı; bu poliçenin ödemeleri şu an gösterilemiyor.' : 'Ödemeler okunuyor…')
          : payouts.length
            ? payouts.map(payoutCard)
            : el('div', { className: 'empty' }, 'Bu poliçe için ödeme kaydı yok.'),
        el('p', { className: 'notice' }, 'Defter bir ödeme talimatını onaylar; ödemeyi sigortacı kendi sistemiyle yapar ve sonucu API üzerinden bildirir.'),
        el('h3', { className: 'section' }, 'İşlem geçmişi'),
        record.events.length
          ? el('ol', { className: 'events' }, record.events.map((e) => eventItem(e, record)))
          : el('div', { className: 'empty' }, 'Bu poliçe için kayıtlı işlem yok.'),
        record.eventsTruncated ? el('div', { className: 'cell-sub' }, 'En yeni 50 işlem gösteriliyor.') : null));
    $('back').addEventListener('click', () => $('list-title').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  // The policy record carries no currency; the list item for it does.
  function currencyOf(policyId) {
    const summary = state.policies.find((s) => s.policyId === policyId);
    return summary ? summary.currency : '';
  }

  async function selectPolicy(policyId, scroll) {
    state.selected = policyId;
    for (const row of document.querySelectorAll('#policy-rows tr')) {
      row.setAttribute('aria-selected', String(row.dataset.id === policyId));
    }
    const token = ++state.detailToken;
    $('detail-placeholder').hidden = true;
    const body = $('detail-body');
    body.hidden = false;
    body.replaceChildren(el('div', { className: 'placeholder' }, 'Poliçe okunuyor…'));
    if (scroll && window.matchMedia('(max-width: 1150px)').matches) {
      $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    try {
      const record = await api(`/policies/${encodeURIComponent(policyId)}`);
      if (token !== state.detailToken) return;
      renderDetail(record);
    } catch (err) {
      if (token !== state.detailToken) return;
      if (err instanceof ApiError && err.status === 401) return failed(err);
      body.replaceChildren(el('div', { className: 'pane-body' }, el('p', { className: 'alert', role: 'alert' }, describe(err))));
    }
  }

  function reset() {
    state.policies = [];
    state.nextCursor = null;
    state.payouts = [];
    state.payoutsByPolicy = new Map();
    state.payoutsTruncated = false;
    state.payoutsStatus = 'loading';
    state.payoutsError = null;
    state.selected = null;
    state.detailToken += 1;
    state.loadToken += 1;
    $('policy-rows').replaceChildren();
    $('detail-body').replaceChildren();
    $('detail-body').hidden = true;
    $('detail-placeholder').hidden = false;
  }

  // --- wiring ----------------------------------------------------------------
  $('key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('key-input');
    const key = input.value.trim();
    input.value = '';
    if (!key) {
      showGate('Anahtar boş olamaz.');
      return;
    }
    reset();
    storeKey(key);
    start();
  });

  $('forget').addEventListener('click', () => {
    forgetKey();
    reset();
    showGate(null);
  });

  $('refresh').addEventListener('click', () => start());

  $('more').addEventListener('click', async () => {
    const load = { token: state.loadToken, key: readKey() };
    $('more').disabled = true;
    try {
      await loadPolicies(false, load);
      if (load.token !== state.loadToken) return;
      renderKpis();
      renderList();
    } catch (err) {
      if (load.token === state.loadToken) failed(err);
    } finally {
      $('more').disabled = false;
    }
  });

  if (readKey()) start();
  else showGate(null);
})();
