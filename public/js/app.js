/* ==========================================================
   QuickAtlas — logique front-end (vanilla JS, sans framework)
   ========================================================== */
const API = '/api';
function categoryLabel(cat) {
  return cat && cat.slug ? i18n.t('category.' + cat.slug) : (cat ? cat.name : '');
}
function subcategoryLabel(sub) {
  return sub && sub.slug ? i18n.t('subcategory.' + sub.slug) : (sub ? sub.name : '');
}
function listingCategoryLabel(l) {
  return l && l.category_slug ? i18n.t('category.' + l.category_slug) : (l ? l.category_name : '');
}
function listingSubcategoryLabel(l) {
  return l && l.subcategory_slug ? i18n.t('subcategory.' + l.subcategory_slug) : (l ? l.subcategory_name : '');
}
function countryLabel(c) {
  return c && c.iso2 ? i18n.t('countryname.' + c.iso2.toLowerCase()) : (c ? c.name : '');
}
function listingCountryLabel(l) {
  return l && l.country_iso2 ? i18n.t('countryname.' + l.country_iso2.toLowerCase()) : (l ? l.country_name : '');
}
const WORLD_ATLAS_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
const state = {
  token: localStorage.getItem('atlas_token') || null,
  user: JSON.parse(localStorage.getItem('atlas_user') || 'null'),
  categories: [],
  countries: [],
  selectedCountry: null,
  selectedState: null,
  selectedCity: null,
  currentListings: [],
  displayCurrency: '',
  rates: null,
  ratesUpdatedAt: null,
  lists: { featured: [], city: [], search: [], mine: [], adminUsers: [], adminListings: [], adminStats: null, conversations: [], adminReports: [], adminEmails: [], adminCategories: [], favorites: [] },
  favoriteIds: new Set(),
  favoriteCountryIds: new Set(),
  favoriteCityIds: new Set(),
  lastStates: null,
  lastCities: null,
  clockTimer: null,
};
// ---------- Helpers API ----------
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    state.token = null;
    state.user = null;
    localStorage.removeItem('atlas_token');
    localStorage.removeItem('atlas_user');
    renderAuthZone();
    showToast(i18n.t('toast.session_expired'));
    openAuthModal('login');
  }
  if (!res.ok) throw new Error(data.error || 'Erreur inconnue');
  return data;
}
function listingTypeLabel(type) {
  const key = { vente: 'type.vente', location: 'type.location', achat: 'type.achat', offre_emploi: 'type.offre_emploi', demande_emploi: 'type.demande_emploi' }[type];
  return key ? i18n.t(key) : type;
}
function isJobType(type) {
  return type === 'offre_emploi' || type === 'demande_emploi';
}
function hasOptionalPrice(type) {
  return isJobType(type) || type === 'achat';
}
function fmtPrice(price, currency) {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(price);
  } catch {
    return `${price} ${currency}`;
  }
}
function priceLabel(listing) {
  if (listing.price === null || listing.price === undefined) {
    if (listing.listing_type === 'achat') return i18n.t('price.budget_open');
    return isJobType(listing.listing_type) ? i18n.t('price.negotiable_job') : i18n.t('price.negotiable_good');
  }
  const native = fmtPrice(listing.price, listing.currency);
  const suffix = isJobType(listing.listing_type) ? ' / mois' : '';
  const prefix = listing.listing_type === 'achat' ? i18n.t('price.budget_max_prefix') + ' ' : '';
  if (!state.displayCurrency || state.displayCurrency === listing.currency || !state.rates) {
    return prefix + native + suffix;
  }
  const rateFrom = state.rates[listing.currency];
  const rateTo = state.rates[state.displayCurrency];
  if (!rateFrom || !rateTo) return prefix + native + suffix;
  const converted = (listing.price / rateFrom) * rateTo;
  return `${prefix}${fmtPrice(converted, state.displayCurrency)}${suffix}  ·  ${native}${suffix}`;
}
async function loadExchangeRates() {
  const note = document.getElementById('currencyNote');
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    if (data && data.rates) {
      state.rates = data.rates;
      state.ratesUpdatedAt = data.time_last_update_utc || new Date().toISOString();
      note.textContent = i18n.t('currency.note_ok');
    } else {
      throw new Error('réponse inattendue');
    }
  } catch {
    note.textContent = i18n.t('currency.note_fail');
  }
}
/** Devine une devise plausible à partir de la langue/région du
 * navigateur du visiteur (ex. navigator.language "fr-MA" -> MAD), pour
 * présélectionner une devise pertinente sans jamais forcer l'utilisateur
 * — il reste libre de changer à tout moment via le sélecteur. */
function guessCurrencyFromBrowserLocale() {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    const guess = state.countries.find((c) => c.iso2 === region);
    return guess ? guess.currency : null;
  } catch {
    return null;
  }
}
function populateCurrencySelect() {
  const select = document.getElementById('displayCurrency');
  const currencies = Array.from(new Set(state.countries.map((c) => c.currency))).sort();
  for (const cur of currencies) {
    select.append(el('option', { value: cur }, cur));
  }
  if (!state.displayCurrency) {
    const guessed = guessCurrencyFromBrowserLocale();
    if (guessed && currencies.includes(guessed)) {
      state.displayCurrency = guessed;
      select.value = guessed;
    }
  }
  select.addEventListener('change', () => {
    state.displayCurrency = select.value;
    rerenderAllPrices();
  });
}
function rerenderAllPrices() {
  renderCardsInto('featuredGrid', state.lists.featured);
  renderCardsInto('listingGrid', state.lists.city);
  renderCardsInto('searchResultsGrid', state.lists.search);
  renderMyListings(state.lists.mine);
  if (state.lists.favorites.length) renderCardsInto('favoritesGrid', state.lists.favorites);
  renderRecentlyViewed();
}
function renderCardsInto(containerId, listings) {
  const grid = document.getElementById(containerId);
  if (!grid || grid.hidden || !listings) return;
  grid.innerHTML = '';
  if (listings.length === 0) {
    grid.append(el('div', { class: 'empty-state' }, i18n.t('empty.no_listings')));
    return;
  }
  for (const l of listings) grid.append(renderListingCard(l));
}
// ---------- Heure locale ----------
function formatLocalTime(timezone) {
  try {
    const now = new Date();
    const time = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
    const offsetParts = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(now);
    const offset = (offsetParts.find((p) => p.type === 'timeZoneName') || {}).value || '';
    return `${time} (${timezone.replace('_', ' ')}, ${offset})`;
  } catch {
    return null;
  }
}
function startCityClock(timezone) {
  stopCityClock();
  const el2 = document.getElementById('localTime');
  if (!timezone) { el2.hidden = true; return; }
  const tick = () => {
    const label = formatLocalTime(timezone);
    if (label) { el2.textContent = `${i18n.t('clock.prefix')} ${label}`; el2.hidden = false; }
    else { el2.hidden = true; }
  };
  tick();
  state.clockTimer = setInterval(tick, 1000);
}
function stopCityClock() {
  if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; }
}
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 3200);
}
function friendlyErrorMessage(err) {
  if (err.message === 'EMAIL_NOT_VERIFIED') return i18n.t('verify.required_action');
  if (err.message === 'AI_NOT_CONFIGURED') return i18n.t('ai.not_configured_error');
  return err.message;
}
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.append(c);
  }
  return node;
}
// ---------- Auth zone ----------
function renderAuthZone() {
  const zone = document.getElementById('authZone');
  zone.innerHTML = '';
  document.getElementById('adminNavLink').hidden = !(state.user && state.user.role === 'admin');
  document.getElementById('messagesNavLink').hidden = !state.user;
  document.getElementById('favoritesNavLink').hidden = !state.user;
  document.getElementById('alertsNavLink').hidden = !state.user;
  document.getElementById('passportNavLink').hidden = !state.user;
  document.getElementById('verifyBanner').hidden = !(state.user && !state.user.email_verified);
  if (state.user) {
    refreshUnreadCount();
    zone.append(
      el('span', { class: 'user-chip' }, [document.createTextNode(i18n.t('auth.hello') + ' '), el('strong', {}, state.user.name)]),
      el('button', { class: 'btn btn--ghost btn--small', onclick: openAiSettingsModal }, i18n.t('ai.settings_button')),
      el('button', { class: 'btn btn--ghost btn--small', onclick: logout }, i18n.t('auth.logout'))
    );
  } else {
    zone.append(el('button', { class: 'btn btn--primary btn--small', onclick: () => openAuthModal('login') }, i18n.t('auth.login')));
  }
}
function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('atlas_token');
  localStorage.removeItem('atlas_user');
  renderAuthZone();
  showToast(i18n.t('toast.logged_out'));
  navigate('explore');
}
function openAuthModal(tab = 'login') {
  document.getElementById('authModal').hidden = false;
  switchAuthTab(tab);
}
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === (tab === 'forgot' || tab === 'reset' ? 'login' : tab)));
  document.querySelector('.auth-tabs').hidden = tab === 'forgot' || tab === 'reset';
  document.getElementById('loginForm').hidden = tab !== 'login';
  document.getElementById('registerForm').hidden = tab !== 'register';
  document.getElementById('forgotPasswordForm').hidden = tab !== 'forgot';
  document.getElementById('resetPasswordForm').hidden = tab !== 'reset';
}
document.getElementById('forgotPasswordLink').addEventListener('click', () => switchAuthTab('forgot'));
document.getElementById('backToLoginLink').addEventListener('click', () => switchAuthTab('login'));
document.getElementById('forgotPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('forgotPasswordError');
  errEl.hidden = true;
  try {
    await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: fd.get('email') }) });
    showToast(i18n.t('toast.reset_link_sent'));
    document.getElementById('authModal').hidden = true;
    e.target.reset();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
let pendingResetToken = null;
document.getElementById('resetPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('resetPasswordError');
  errEl.hidden = true;
  try {
    await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: pendingResetToken, password: fd.get('password') }) });
    showToast(i18n.t('toast.password_reset_done'));
    document.getElementById('authModal').hidden = true;
    switchAuthTab('login');
    e.target.reset();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
function setupPasswordStrengthMeter(inputId, wrapId, fillId, labelId) {
  const input = document.getElementById(inputId);
  const wrap = document.getElementById(wrapId);
  const fill = document.getElementById(fillId);
  const label = document.getElementById(labelId);
  const levels = [
    { color: '#B5482E', key: 'password.strength_weak' },
    { color: '#B5482E', key: 'password.strength_weak' },
    { color: '#C6A15B', key: 'password.strength_medium' },
    { color: '#4C8C82', key: 'password.strength_strong' },
    { color: '#4C8C82', key: 'password.strength_strong' },
  ];
  input.addEventListener('input', () => {
    if (!input.value) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const score = passwordStrengthScore(input.value);
    const level = levels[score];
    fill.style.width = `${(score / 4) * 100}%`;
    fill.style.background = level.color;
    label.textContent = i18n.t(level.key);
  });
}
function passwordStrengthScore(password) {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  return Math.min(score, 4);
}
setupPasswordStrengthMeter('registerPassword', 'passwordStrength', 'passwordStrengthFill', 'passwordStrengthLabel');
setupPasswordStrengthMeter('resetPassword', 'resetPasswordStrength', 'resetPasswordStrengthFill', 'resetPasswordStrengthLabel');
// ---------- Bannière : icônes catégories, promo, navigation par catégorie ----------
function renderCategoryIconRow() {
  const row = document.getElementById('categoryIconRow');
  row.innerHTML = '';
  for (const c of state.categories) {
    row.append(
      el('button', { class: 'category-pill', onclick: () => browseCategory(c) }, categoryLabel(c))
    );
  }
}
function setExploreStageVisibility(stage) {
  const byId = (id) => document.getElementById(id);
  const force = (el, hide) => { if (el) el.classList.toggle('explore-force-hidden', hide); };
  const ticker = byId('activityTicker');
  const promo = byId('promoBanner');
  const stats = byId('statsBar');
  const currency = document.querySelector('.currency-picker');
  const countrySection = byId('countrySection');
  const categoryRow = byId('categoryIconRow');
  const recently = byId('recentlyViewedSection');
  const featured = byId('featuredSection');
  const reopenMapBtn = byId('reopenMapBtn');
  if (reopenMapBtn) reopenMapBtn.hidden = stage === 'landing';
  const hideTopBar = stage !== 'landing';
  force(ticker, hideTopBar);
  force(promo, hideTopBar);
  force(countrySection, stage === 'city');
  force(stats, stage === 'country');
  force(currency, stage === 'country');
  force(categoryRow, stage === 'city');
  force(recently, stage === 'country');
  force(featured, stage === 'country');
}
function refreshCategoryTexts() {
  renderCategoryIconRow();
  const catFilter = document.getElementById('categoryFilter');
  const pubCat = document.getElementById('publishCategory');
  if (catFilter) {
    for (const opt of catFilter.options) {
      const cat = findCategoryBySlug(opt.value);
      if (cat) opt.textContent = `${cat.icon} ${categoryLabel(cat)}`;
    }
  }
  if (pubCat) {
    for (const opt of pubCat.options) {
      const cat = findCategoryById(opt.value);
      if (cat) opt.textContent = `${cat.icon} ${categoryLabel(cat)}`;
    }
  }
  const footerCats = document.getElementById('footerCats');
  if (footerCats) {
    footerCats.innerHTML = '';
    for (const c of state.categories) {
      footerCats.append(el('span', {}, `${c.icon} ${categoryLabel(c)}`));
    }
  }
  const subFilter = document.getElementById('subcategoryFilter');
  if (subFilter && catFilter) {
    const prevVal = subFilter.value;
    fillSubcategorySelect(subFilter, findCategoryBySlug(catFilter.value), true);
    subFilter.value = prevVal;
  }
  const pubSub = document.getElementById('publishSubcategory');
  if (pubSub && pubCat) {
    const prevVal = pubSub.value;
    fillSubcategorySelect(pubSub, findCategoryById(pubCat.value), false);
    pubSub.value = prevVal;
  }
  if (state.categoryBrowse && state.categoryBrowse.category) {
    const catBrowseSub = document.getElementById('categoryBrowseSubcategory');
    if (catBrowseSub) {
      const prevVal = catBrowseSub.value;
      fillSubcategorySelect(catBrowseSub, state.categoryBrowse.category, true);
      catBrowseSub.value = prevVal;
    }
    renderCategoryBreadcrumb();
    const title = document.getElementById('searchResultsTitle');
    if (title) title.textContent = `${state.categoryBrowse.category.icon} ${categoryLabel(state.categoryBrowse.category)}`;
  }
}
async function loadPromoBanner() {
  try {
    const promo = await api('/listings/promo');
    const banner = document.getElementById('promoBanner');
    if (!promo) { banner.hidden = true; return; }
    banner.href = '#';
    banner.onclick = (e) => { e.preventDefault(); openListingDetail(promo.id); };
    document.getElementById('promoBannerIcon').textContent = promo.category_icon;
    document.getElementById('promoBannerTitle').textContent = promo.title;
    document.getElementById('promoBannerPlace').textContent = `${promo.city_name}, ${listingCountryLabel(promo)}`;
    banner.hidden = false;
  } catch {
    document.getElementById('promoBanner').hidden = true;
  }
}
// ---------- Ticker d'activité mondiale + carte vivante ----------
let knownActivityIds = null;
async function loadActivityTicker() {
  try {
    const items = await api('/activity-feed');
    const track = document.getElementById('activityTickerTrack');
    track.innerHTML = '';
    for (const item of items) {
      track.append(
        el('span', { class: 'activity-ticker-item' }, [
          `${item.category_icon} `,
          el('strong', {}, item.title),
          ` — ${item.city_name}, ${listingCountryLabel(item)}`,
        ])
      );
    }
    const currentIds = new Set(items.map((i) => i.id));
    if (knownActivityIds) {
      for (const item of items) {
        if (!knownActivityIds.has(item.id)) pulseCountry(item.country_iso_numeric);
      }
    }
    knownActivityIds = currentIds;
  } catch { /* silencieux */ }
}
function pulseCountry(isoNumeric) {
  if (!mapSelection || !isoNumeric) return;
  const path = mapSelection.select(`path[data-iso="${String(Number(isoNumeric))}"]`);
  if (path.empty()) return;
  const bbox = path.node().getBBox();
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const circle = mapSelection.append('circle')
    .attr('cx', cx).attr('cy', cy).attr('r', 2)
    .attr('class', 'map-pulse-ripple')
    .style('opacity', 1);
  circle.transition().duration(2200).ease(d3.easeCubicOut)
    .attr('r', Math.max(bbox.width, bbox.height, 20))
    .style('opacity', 0)
    .on('end', function () { d3.select(this).remove(); });
}
state.categoryBrowse = { category: null, subcategory: '', type: '', sort: 'newest' };
/** Masque la case "Occasion uniquement" (recherche) ou "Cet article est
 * d'occasion" (publication) quand la catégorie active est Tourisme &
 * Voyages — la notion de seconde main n'a pas de sens pour un voyage ou
 * une excursion. Ne fait rien si l'élément n'existe pas sur la page. */
function updateSecondhandVisibility(categorySlug, checkboxId) {
  const checkbox = document.getElementById(checkboxId);
  if (!checkbox) return;
  const row = checkbox.closest('label');
  if (!row) return;
  const isTourism = categorySlug === 'tourisme-voyages';
  row.hidden = isTourism;
  if (isTourism) checkbox.checked = false;
}
/** Affiche les champs "Date de début / Date de fin" uniquement pour la
 * catégorie Tourisme & Voyages (séjour, excursion, croisière…) — les vide
 * quand on les masque, pour ne jamais envoyer une date orpheline d'une
 * catégorie précédemment sélectionnée. */
/** Catégories pour lesquelles les dates et le prix promotionnel ont un
 * sens réel (séjours pour le Tourisme, disponibilité pour l'Immobilier).
 * Pour les autres catégories, les champs restent visibles mais grisés
 * plutôt que masqués — pour que leur existence reste prévisible dans le
 * formulaire, sans pour autant inviter à les remplir hors contexte. */
const DATES_PRICE_EXTRAS_CATEGORIES = ['tourisme-voyages', 'immobilier'];
function updateTourismDatesVisibility(categorySlug) {
  const row = document.getElementById('tourismDatesRow');
  if (!row) return;
  const isRelevant = DATES_PRICE_EXTRAS_CATEGORIES.includes(categorySlug);
  row.classList.toggle('form-row--disabled', !isRelevant);
  const startInput = document.getElementById('publishDateStart');
  const endInput = document.getElementById('publishDateEnd');
  if (startInput) startInput.disabled = !isRelevant;
  if (endInput) endInput.disabled = !isRelevant;
  if (!isRelevant) {
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
  }
}
/** Même principe que updateTourismDatesVisibility, pour le bloc
 * "Prix promotionnel / Type de prix". */
function updateTourismPriceExtrasVisibility(categorySlug) {
  const row = document.getElementById('tourismPriceExtrasRow');
  if (!row) return;
  const isRelevant = DATES_PRICE_EXTRAS_CATEGORIES.includes(categorySlug);
  row.classList.toggle('form-row--disabled', !isRelevant);
  const promoInput = document.getElementById('publishPricePromo');
  const typeSelect = document.getElementById('publishPriceType');
  if (promoInput) promoInput.disabled = !isRelevant;
  if (typeSelect) typeSelect.disabled = !isRelevant;
  if (!isRelevant) {
    if (promoInput) promoInput.value = '';
    if (typeSelect) typeSelect.value = '';
  }
}
async function browseCategory(category) {
  resetExplore();
  state.categoryBrowse = { category, subcategory: '', type: '', sort: 'newest' };
  showSearchMode(true);
  document.getElementById('categoryBreadcrumb').hidden = false;
  document.getElementById('categoryBrowseFilters').hidden = false;
  updateSecondhandVisibility(category.slug, 'categoryBrowseSecondhandCheckbox');
  updateTourismDatesVisibility(category.slug);
  updateTourismPriceExtrasVisibility(category.slug);
  fillSubcategorySelect(document.getElementById('categoryBrowseSubcategory'), category, true);
  updateCategoryBrowseTypeOptions(category.slug);
  document.getElementById('categoryBrowseSort').value = 'newest';
  renderCategoryBreadcrumb();
  await runCategoryBrowseSearch();
  document.getElementById('searchResultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function updateCategoryBrowseTypeOptions(categorySlug) {
  const select = document.getElementById('categoryBrowseType');
  const isEmploi = categorySlug === 'emploi';
  select.innerHTML = '';
  if (isEmploi) {
    select.append(el('option', { value: '' }, i18n.t('filter.type_job_default')));
    select.append(el('option', { value: 'offre_emploi' }, i18n.t('filter.type_job_offer')));
    select.append(el('option', { value: 'demande_emploi' }, i18n.t('filter.type_job_seek')));
  } else {
    select.append(el('option', { value: '' }, i18n.t('filter.type_default')));
    select.append(el('option', { value: 'vente' }, i18n.t('filter.type_sale')));
    select.append(el('option', { value: 'location' }, i18n.t('filter.type_rent')));
    select.append(el('option', { value: 'achat' }, i18n.t('filter.type_buy')));
  }
}
function renderCategoryBreadcrumb() {
  const bc = document.getElementById('categoryBreadcrumb');
  bc.innerHTML = '';
  const { category, subcategory } = state.categoryBrowse;
  bc.append(el('button', { onclick: () => { showSearchMode(false); } }, i18n.t('filter.all_categories')));
  if (category) {
    bc.append(document.createTextNode(' / '), el('span', {}, `${category.icon} ${categoryLabel(category)}`));
  }
  if (subcategory) {
    const sub = category.subcategories.find((s) => s.slug === subcategory);
    if (sub) bc.append(document.createTextNode(' / '), el('span', {}, subcategoryLabel(sub)));
  }
  const type = state.categoryBrowse.type;
  if (type) bc.append(document.createTextNode(' / '), el('span', {}, listingTypeLabel(type)));
}
async function runCategoryBrowseSearch() {
  const { category, subcategory, type, sort } = state.categoryBrowse;
  document.getElementById('searchResultsTitle').textContent = `${category.icon} ${categoryLabel(category)}`;
  const params = new URLSearchParams({ category: category.slug, sort });
  if (subcategory) params.set('subcategory', subcategory);
  if (type) params.set('type', type);
  if (document.getElementById('categoryBrowseSecondhandCheckbox').checked) params.set('secondhand', '1');
  const grid = document.getElementById('searchResultsGrid');
  try {
    const results = await api(`/listings/search?${params.toString()}`);
    state.lists.search = results;
    renderCardsInto('searchResultsGrid', results);
  } catch {
    grid.innerHTML = '';
    grid.append(el('div', { class: 'empty-state' }, i18n.t('empty.search_failed')));
  }
}
document.getElementById('categoryBrowseSubcategory').addEventListener('change', (e) => {
  state.categoryBrowse.subcategory = e.target.value;
  renderCategoryBreadcrumb();
  runCategoryBrowseSearch();
});
document.getElementById('categoryBrowseType').addEventListener('change', (e) => {
  state.categoryBrowse.type = e.target.value;
  renderCategoryBreadcrumb();
  runCategoryBrowseSearch();
});
document.getElementById('categoryBrowseSort').addEventListener('change', (e) => {
  state.categoryBrowse.sort = e.target.value;
  runCategoryBrowseSearch();
});
document.getElementById('categoryBrowseSecondhandCheckbox').addEventListener('change', runCategoryBrowseSearch);
document.getElementById('reopenMapBtn').addEventListener('click', reopenMap);
document.getElementById('showCountrySheetBtn').addEventListener('click', () => {
  if (state.selectedCountry) openCountrySheet(state.selectedCountry);
});
// ---------- Navigation entre écrans ----------
let allListingsViewInitialized = false;
function initAllListingsView() {
  if (allListingsViewInitialized) return;
  allListingsViewInitialized = true;
  const catSelect = document.getElementById('allListingsCategoryFilter');
  catSelect.append(el('option', { value: '' }, i18n.t('filter.all_categories')));
  for (const c of state.categories) {
    catSelect.append(el('option', { value: c.slug }, `${c.icon} ${categoryLabel(c)}`));
  }
  let debounceTimer;
  document.getElementById('allListingsSearchInput').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadAllListings, 400);
  });
  catSelect.addEventListener('change', loadAllListings);
  document.getElementById('allListingsSortFilter').addEventListener('change', loadAllListings);
}
async function loadAllListings() {
  try {
    const q = document.getElementById('allListingsSearchInput').value.trim();
    const category = document.getElementById('allListingsCategoryFilter').value;
    const sort = document.getElementById('allListingsSortFilter').value;
    const params = new URLSearchParams({ browse_all: '1', sort });
    if (q) params.set('q', q);
    if (category) params.set('category', category);
    const listings = await api(`/listings/search?${params.toString()}`);
    renderCardsInto('allListingsGrid', listings);
  } catch (e) {
    showToast(e.message);
  }
}
function navigate(view) {
  document.getElementById('authModal').hidden = true;
  document.getElementById('listingModal').hidden = true;
  document.getElementById('countryModal').hidden = true;
  document.getElementById('compareModal').hidden = true;
  document.getElementById('cityRequestModal').hidden = true;
  document.getElementById('randomExploreModal').hidden = true;
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  document.getElementById(`view-${view}`).hidden = false;
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  document.body.classList.remove('nav-open');
  if (view === 'publish') {
    if (!state.user) { navigate('explore'); openAuthModal('login'); return; }
    preparePublishForm();
  }
  if (view === 'mine') {
    if (!state.user) { navigate('explore'); openAuthModal('login'); return; }
    loadMyListings();
  }
  if (view === 'messages') {
    if (!state.user) { navigate('explore'); openAuthModal('login'); return; }
    loadConversations();
  }
  if (view === 'favorites') {
    if (!state.user) { navigate('explore'); openAuthModal('login'); return; }
    loadFavorites();
  }
  if (view === 'all-listings') {
    initAllListingsView();
    loadAllListings();
  }
  if (view === 'alerts') {
    if (!state.user) { navigate('explore'); openAuthModal('login'); return; }
    loadAlerts();
  }
  if (view === 'passport') {
    if (!state.user) { navigate('explore'); openAuthModal('login'); return; }
    loadPassport();
  }
  if (view === 'admin') {
    if (!state.user || state.user.role !== 'admin') { showToast(i18n.t('toast.admin_denied')); navigate('explore'); return; }
    loadAdminStats();
    loadAdminUsers();
    loadAdminListings();
    loadAdminReports();
    loadAdminEmails();
    initAdminCategoryCountrySelector();
    loadCategoryStatusList();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav)));
document.getElementById('burgerBtn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => (document.getElementById(b.dataset.close).hidden = true))
);
document.querySelectorAll('.modal-overlay').forEach((ov) =>
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true; })
);
document.querySelectorAll('.auth-tab').forEach((b) => b.addEventListener('click', () => switchAuthTab(b.dataset.tab)));
// ---------- Mode d'emploi / guide ----------
document.getElementById('helpFabBtn').addEventListener('click', () => {
  document.getElementById('helpModal').hidden = false;
});
document.getElementById('footerHowItWorksBtn').addEventListener('click', () => {
  document.getElementById('helpModal').hidden = false;
});
document.getElementById('footerAlertsHowToBtn').addEventListener('click', () => {
  document.getElementById('helpModal').hidden = false;
  const section = document.getElementById('helpAlertsSection');
  section.open = true;
  setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
});
document.getElementById('footerPrivacyBtn').addEventListener('click', () => {
  navigate('terms');
  setTimeout(() => {
    document.querySelector('[data-i18n="privacy.title"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
});
document.getElementById('helpDontShowAgain').addEventListener('change', (e) => {
  if (e.target.checked) localStorage.setItem('quickatlas_guide_dismissed', '1');
  else localStorage.removeItem('quickatlas_guide_dismissed');
});
function maybeShowGuideOnFirstVisit() {
  if (localStorage.getItem('quickatlas_guide_dismissed')) return;
  if (localStorage.getItem('quickatlas_guide_seen')) return;
  localStorage.setItem('quickatlas_guide_seen', '1');
  document.getElementById('helpModal').hidden = false;
}
// ---------- Chargement des référentiels ----------
async function loadCategories() {
  state.categories = await api('/categories');
  const catFilter = document.getElementById('categoryFilter');
  const pubCat = document.getElementById('publishCategory');
  const footerCats = document.getElementById('footerCats');
  for (const c of state.categories) {
    catFilter.append(el('option', { value: c.slug }, `${c.icon} ${categoryLabel(c)}`));
    pubCat.append(el('option', { value: c.id }, `${c.icon} ${categoryLabel(c)}`));
    footerCats.append(el('span', {}, `${c.icon} ${categoryLabel(c)}`));
  }
  renderCategoryIconRow();
  fillSubcategorySelect(document.getElementById('publishSubcategory'), findCategoryById(pubCat.value), false);
  updatePublishTypeAndPriceUI(findCategoryById(pubCat.value));
  pubCat.addEventListener('change', () => {
    fillSubcategorySelect(document.getElementById('publishSubcategory'), findCategoryById(pubCat.value), false);
    updatePublishTypeAndPriceUI(findCategoryById(pubCat.value));
    updateSecondhandVisibility(findCategoryById(pubCat.value)?.slug, 'secondhandCheckbox');
    updateTourismDatesVisibility(findCategoryById(pubCat.value)?.slug);
    updateTourismPriceExtrasVisibility(findCategoryById(pubCat.value)?.slug);
  });
  catFilter.addEventListener('change', () => {
    fillSubcategorySelect(document.getElementById('subcategoryFilter'), findCategoryBySlug(catFilter.value), true);
    updateTypeFilterOptions(catFilter.value);
    updateSecondhandVisibility(catFilter.value, 'secondhandFilterCheckbox');
    refreshListings();
  });
  updateTypeFilterOptions(catFilter.value);
  document.getElementById('subcategoryFilter').addEventListener('change', refreshListings);
}
function updatePublishTypeAndPriceUI(category) {
  const typeSelect = document.getElementById('publishListingType');
  const priceLabelEl = document.getElementById('publishPriceLabel');
  const priceInput = document.getElementById('publishPrice');
  const currencyLabelEl = document.getElementById('publishCurrencyLabel');
  const isEmploi = category && category.slug === 'emploi';
  const previousValue = typeSelect.value;
  typeSelect.innerHTML = '';
  currencyLabelEl.firstChild.textContent = isEmploi ? i18n.t('publish.label_currency_job') : i18n.t('publish.label_currency');
  if (isEmploi) {
    typeSelect.append(el('option', { value: 'offre_emploi' }, i18n.t('type.offre_emploi')));
    typeSelect.append(el('option', { value: 'demande_emploi' }, i18n.t('type.demande_emploi')));
  } else {
    typeSelect.append(el('option', { value: 'vente' }, i18n.t('type.vente')));
    typeSelect.append(el('option', { value: 'location' }, i18n.t('type.location')));
    typeSelect.append(el('option', { value: 'achat' }, i18n.t('type.achat')));
  }
  const applyPriceRequirement = () => {
    if (hasOptionalPrice(typeSelect.value)) {
      priceLabelEl.firstChild.textContent = typeSelect.value === 'achat' ? i18n.t('publish.label_price_budget') : i18n.t('publish.label_price_job');
      priceInput.removeAttribute('required');
      priceInput.placeholder = typeSelect.value === 'achat' ? i18n.t('price.budget_open') : i18n.t('price.negotiable_job');
    } else {
      priceLabelEl.firstChild.textContent = i18n.t('publish.label_price');
      priceInput.setAttribute('required', '');
      priceInput.placeholder = '0';
    }
  };
  typeSelect.onchange = applyPriceRequirement;
  if ([...typeSelect.options].some((o) => o.value === previousValue)) typeSelect.value = previousValue;
  applyPriceRequirement();
}
function updateTypeFilterOptions(categorySlug) {
  const typeFilter = document.getElementById('typeFilter');
  const isEmploi = categorySlug === 'emploi';
  const previousValue = typeFilter.value;
  typeFilter.innerHTML = '';
  if (isEmploi) {
    typeFilter.append(el('option', { value: '' }, i18n.t('filter.type_job_default')));
    typeFilter.append(el('option', { value: 'offre_emploi' }, i18n.t('filter.type_job_offer')));
    typeFilter.append(el('option', { value: 'demande_emploi' }, i18n.t('filter.type_job_seek')));
  } else {
    typeFilter.append(el('option', { value: '' }, i18n.t('filter.type_default')));
    typeFilter.append(el('option', { value: 'vente' }, i18n.t('filter.type_sale')));
    typeFilter.append(el('option', { value: 'location' }, i18n.t('filter.type_rent')));
    typeFilter.append(el('option', { value: 'achat' }, i18n.t('filter.type_buy')));
  }
  if ([...typeFilter.options].some((o) => o.value === previousValue)) typeFilter.value = previousValue;
}
function findCategoryById(id) {
  return state.categories.find((c) => String(c.id) === String(id));
}
function findCategoryBySlug(slug) {
  return state.categories.find((c) => c.slug === slug);
}
function findSubcategoryById(id) {
  for (const c of state.categories) {
    const s = (c.subcategories || []).find((s) => String(s.id) === String(id));
    if (s) return s;
  }
  return null;
}
/** Affiche les champs Hébergement (capacité, chambres, sdb, équipements)
 * uniquement pour les sous-catégories Locations de vacances et Hôtellerie
 * & hébergements insolites — contrairement aux dates/prix promo qui sont
 * pilotés par la catégorie, ceci dépend de la sous-catégorie choisie. */
function updateTourismLodgingVisibility(subcategorySlug) {
  const row = document.getElementById('tourismLodgingRow');
  if (!row) return;
  const isLodging = ['locations-vacances', 'hotellerie-insolite'].includes(subcategorySlug);
  row.hidden = !isLodging;
  if (!isLodging) {
    ['publishCapacityGuests', 'publishBedrooms', 'publishBathrooms'].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = '';
    });
    row.querySelectorAll('input[name="amenities"]').forEach((cb) => { cb.checked = false; });
  }
}
function fillSubcategorySelect(selectEl, category, withAllOption) {
  selectEl.innerHTML = '';
  if (withAllOption) selectEl.append(el('option', { value: '' }, i18n.t('filter.all_natures')));
  if (!category) {
    if (!withAllOption) selectEl.append(el('option', { value: '' }, i18n.t('publish.choose_category_first')));
    selectEl.disabled = !withAllOption ? true : false;
    return;
  }
  selectEl.disabled = false;
  for (const s of category.subcategories) {
    selectEl.append(el('option', { value: withAllOption ? s.slug : s.id }, subcategoryLabel(s)));
  }
}
async function loadCountries() {
  state.countries = await api('/countries');
  renderCountryGrid();
  renderStatsBar();
  populateCurrencySelect();
  const pubCountry = document.getElementById('publishCountry');
  pubCountry.innerHTML = '';
  const guessedId = await guessUserCountryId();
  const ordered = guessedId
    ? [...state.countries].sort((a, b) => (a.id === guessedId ? -1 : b.id === guessedId ? 1 : 0))
    : state.countries;
  for (const c of ordered) {
    pubCountry.append(el('option', { value: c.id, selected: c.id === guessedId ? 'selected' : null }, countryLabel(c)));
  }
  pubCountry.addEventListener('change', () => handlePublishCountryChange(pubCountry.value));
  if (state.countries[0]) handlePublishCountryChange(pubCountry.value || state.countries[0].id);
}
async function guessUserCountryId() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const locale = navigator.language;
    const { country } = await api(`/geo-guess?tz=${encodeURIComponent(tz)}&locale=${encodeURIComponent(locale)}`);
    return country ? country.id : null;
  } catch {
    return null;
  }
}
/** Reconstruit proprement un <select> de catégories en excluant celles
 * données — vide entièrement l'élément avant de repeupler (contrairement à
 * loadCategories(), jamais sûr à rappeler plusieurs fois sans ce nettoyage,
 * comme on l'a appris avec le bug de doublon). Conserve la valeur
 * sélectionnée si elle reste disponible après filtrage. */
function rebuildCategorySelectExcluding(selectEl, excludedIds, { withAllOption, valueKey }) {
  if (!selectEl) return;
  const currentValue = selectEl.value;
  selectEl.innerHTML = '';
  if (withAllOption) selectEl.append(el('option', { value: '' }, i18n.t('filter.all_categories')));
  for (const c of state.categories) {
    if (excludedIds.has(c.id)) continue;
    selectEl.append(el('option', { value: valueKey === 'slug' ? c.slug : c.id }, `${c.icon} ${categoryLabel(c)}`));
  }
  if ([...selectEl.options].some((o) => o.value === currentValue)) selectEl.value = currentValue;
}
/** Récupère les catégories désactivées pour un pays et reconstruit le menu
 * donné en conséquence — utilisé à la fois pour la navigation (filtre de
 * ville) et pour la publication (catégorie de l'annonce). Échoue en
 * silence sur le réseau : le menu garde alors sa liste complète actuelle
 * plutôt que de casser l'affichage. */
async function refreshCategoryOptionsForCountry(countryId, selectEl, opts) {
  try {
    const excludedIds = new Set(await api(`/countries/${countryId}/category-exclusions`));
    rebuildCategorySelectExcluding(selectEl, excludedIds, opts);
  } catch {
    /* silencieux */
  }
}
async function handlePublishCountryChange(countryId) {
  const country = findCountryById(countryId);
  if (!country) return;
  document.getElementById('publishForm').querySelector('input[name=currency]').value = country.currency;
  const pubCatSelect = document.getElementById('publishCategory');
  await refreshCategoryOptionsForCountry(country.id, pubCatSelect, { withAllOption: false, valueKey: 'id' });
  pubCatSelect.dispatchEvent(new Event('change'));
  const stateLabel = document.getElementById('publishStateLabel');
  const stateSelect = document.getElementById('publishState');
  if (country.is_federal) {
    stateLabel.hidden = false;
    const states = await api(`/countries/${country.id}/states`);
    stateSelect.innerHTML = '';
    for (const st of states) stateSelect.append(el('option', { value: st.id }, st.name));
    stateSelect.onchange = () => fillPublishCitiesFromStates(stateSelect.value);
    if (states[0]) fillPublishCitiesFromStates(states[0].id);
  } else {
    stateLabel.hidden = true;
    stateSelect.innerHTML = '';
    fillPublishCities(country.id);
  }
}
function findCountryById(id) {
  return state.countries.find((c) => String(c.id) === String(id));
}
async function fillPublishCitiesFromStates(stateId) {
  const cities = await api(`/states/${stateId}/cities`);
  const sel = document.getElementById('publishCity');
  sel.innerHTML = '';
  for (const c of cities) sel.append(el('option', { value: c.id }, c.name));
}
function renderStatsBar() {
  const bar = document.getElementById('statsBar');
  bar.innerHTML = '';
  const cityCount = state.countries.reduce((sum, c) => sum + c.city_count, 0);
  const listingCount = state.countries.reduce((sum, c) => sum + c.listing_count, 0);
  const stats = [
    [state.countries.length, i18n.t('stats.countries')],
    [cityCount, i18n.t('stats.cities')],
    [listingCount, i18n.t('stats.listings')],
  ];
  for (const [value, label] of stats) {
    bar.append(el('div', {}, [el('dd', {}, String(value)), el('dt', {}, label)]));
  }
}
async function loadFeatured() {
  try {
    const countryId = state.selectedCountry ? state.selectedCountry.id : '';
    const listings = await api(`/listings/featured?limit=8${countryId ? `&country_id=${countryId}` : ''}`);
    state.lists.featured = listings;
    const section = document.getElementById('featuredSection');
    const grid = document.getElementById('featuredGrid');
    if (listings.length === 0) { section.hidden = true; return; }
    section.hidden = false;
    grid.hidden = false;
    const isFromVisitedCountry = state.selectedCountry && listings.some((l) => l.country_name === state.selectedCountry.name);
    document.getElementById('featuredSectionTitle').textContent = isFromVisitedCountry
      ? i18n.t('featured.title_country', { country: countryLabel(state.selectedCountry) })
      : i18n.t('featured.title');
    renderCardsInto('featuredGrid', listings);
  } catch {
    /* section reste masquée si l'appel échoue */
  }
}
async function fillPublishCities(countryId) {
  const cities = await api(`/countries/${countryId}/cities`);
  const sel = document.getElementById('publishCity');
  sel.innerHTML = '';
  for (const c of cities) sel.append(el('option', { value: c.id }, c.name));
}
function renderCountryGrid() {
  setupCountryCombobox();
}
let comboActiveIndex = -1;
let comboFilteredCountries = [];
function setupCountryCombobox() {
  const input = document.getElementById('countrySearchInput');
  const list = document.getElementById('countryOptions');
  function renderOptions(query) {
    const q = (query || '').trim().toLowerCase();
    comboFilteredCountries = q
      ? state.countries.filter((c) => c.name.toLowerCase().includes(q))
      : state.countries;
    comboActiveIndex = -1;
    list.innerHTML = '';
    if (comboFilteredCountries.length === 0) {
      list.append(el('li', { class: 'combobox-empty' }, 'Aucun pays ne correspond.'));
    } else {
      comboFilteredCountries.forEach((c, i) => {
        list.append(
          el('li', {
            class: 'combobox-option',
            role: 'option',
            id: `combo-opt-${i}`,
            onclick: () => { input.value = countryLabel(c); closeOptions(); selectCountry(c, { openSheet: false }); },
          }, [
            el('span', { class: 'combobox-option-name' }, countryLabel(c)),
            el('span', { class: 'combobox-option-meta' }, i18n.t('tile.meta_country', { cities: c.city_count, listings: c.listing_count })),
          ])
        );
      });
    }
  }
  function openOptions() {
    renderOptions(input.value);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function closeOptions() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    comboActiveIndex = -1;
  }
  function setActive(index) {
    list.querySelectorAll('.combobox-option').forEach((o) => o.classList.remove('is-active'));
    if (index >= 0 && comboFilteredCountries[index]) {
      const opt = document.getElementById(`combo-opt-${index}`);
      if (opt) { opt.classList.add('is-active'); opt.scrollIntoView({ block: 'nearest' }); }
    }
    comboActiveIndex = index;
  }
  input.addEventListener('focus', openOptions);
  input.addEventListener('input', openOptions);
  input.addEventListener('blur', () => setTimeout(closeOptions, 150));
  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { openOptions(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(comboActiveIndex + 1, comboFilteredCountries.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(comboActiveIndex - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = comboFilteredCountries[comboActiveIndex] || comboFilteredCountries[0];
      if (chosen) { input.value = countryLabel(chosen); closeOptions(); selectCountry(chosen, { openSheet: false }); }
    } else if (e.key === 'Escape') {
      closeOptions();
    }
  });
}
// ---------- Sélection pays / ville ----------
function flagEmoji(iso2) {
  if (!iso2 || iso2.length !== 2) return '🌍';
  const codePoints = [...iso2.toUpperCase()].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}
function formatPopulation(millions) {
  if (millions === null || millions === undefined) return '—';
  if (millions < 1) return `${Math.round(millions * 1000).toLocaleString('fr-FR')} ${i18n.t('country.thousand_inhabitants')}`;
  return `${millions.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${i18n.t('country.million_inhabitants')}`;
}
function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function openCountrySheet(country) {
  const newPath = `/pays/${slugify(country.name)}`;
  if (window.location.pathname !== newPath) window.history.pushState({ type: 'country', id: country.id }, '', newPath);
  const content = document.getElementById('countryModalContent');
  content.innerHTML = '';
  content.append(
    el('div', { class: 'country-sheet-header' }, [
      el('span', { class: 'country-sheet-flag' }, flagEmoji(country.iso2)),
      el('div', { class: 'country-sheet-title' }, [
        el('h2', {}, countryLabel(country)),
        el('span', { class: 'country-sheet-continent' }, country.continent || ''),
      ]),
    ]),
    el('div', { class: 'country-sheet-stats' }, [
      el('div', { class: 'country-sheet-stat' }, [el('span', { class: 'country-sheet-stat-label' }, i18n.t('country.capital')), el('span', { class: 'country-sheet-stat-value' }, country.capital || '—')]),
      el('div', { class: 'country-sheet-stat' }, [el('span', { class: 'country-sheet-stat-label' }, i18n.t('country.population')), el('span', { class: 'country-sheet-stat-value' }, formatPopulation(country.population_millions))]),
      el('div', { class: 'country-sheet-stat' }, [el('span', { class: 'country-sheet-stat-label' }, i18n.t('country.languages')), el('span', { class: 'country-sheet-stat-value' }, country.languages || '—')]),
      el('div', { class: 'country-sheet-stat' }, [el('span', { class: 'country-sheet-stat-label' }, i18n.t('currency.label')), el('span', { class: 'country-sheet-stat-value' }, country.currency)]),
      el('div', { class: 'country-sheet-stat' }, [el('span', { class: 'country-sheet-stat-label' }, i18n.t('tile.meta_country_label')), el('span', { class: 'country-sheet-stat-value' }, i18n.t('tile.meta_country', { cities: country.city_count, listings: country.listing_count }))]),
    ]),
    el('div', { class: 'country-sheet-actions country-sheet-actions--top' }, [
      el('button', {
        class: 'btn btn--primary',
        onclick: () => {
          document.getElementById('countryModal').hidden = true;
          const target = document.getElementById('stateGrid').hidden
            ? document.getElementById('cityGrid')
            : document.getElementById('stateGrid');
          setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 550);
        },
      }, i18n.t('country.explore_cities')),
      el('button', {
        class: `btn btn--ghost favorite-country-btn ${state.favoriteCountryIds && state.favoriteCountryIds.has(country.id) ? 'is-active' : ''}`,
        onclick: (e) => toggleFavoriteCountry(country.id, e.target),
      }, state.favoriteCountryIds && state.favoriteCountryIds.has(country.id) ? `♥ ${i18n.t('destinations.remove')}` : `♡ ${i18n.t('destinations.add')}`),
    ]),
    el('div', { class: 'country-sheet-profile', id: 'countrySheetProfile' }),
    el('div', { class: 'economic-stats', id: 'economicStats' }),
    el('div', { class: 'business-opportunities', id: 'businessOpportunities' })
  );
  document.getElementById('countryModal').hidden = false;
  loadCountryProfile(country);
  loadEconomicStats(country);
  loadBusinessOpportunities(country);
}
const COUNTRY_PROFILE_TABS = [
  ['business_climate', 'country.tab_business', '💼'],
  ['culture', 'country.tab_culture', '🤝'],
  ['gastronomy', 'country.tab_gastronomy', '🍽️'],
  ['practical_tips', 'country.tab_tips', '🧭'],
  ['holidays', 'country.tab_holidays', '📅'],
];
async function loadCountryProfile(country) {
  const container = document.getElementById('countrySheetProfile');
  let profile;
  try {
    profile = await api(`/countries/${country.id}/profile`);
  } catch {
    profile = null;
  }
  if (!container || document.getElementById('countryModal').hidden) return; // fermé entre-temps
  container.innerHTML = '';
  if (!profile) {
    container.append(el('p', { class: 'country-sheet-soon' }, i18n.t('country.profile_soon')));
    return;
  }
  const tabs = el('div', { class: 'country-sheet-tabs' });
  const body = el('div', { class: 'country-sheet-tab-body' });
  const translateBox = el('div', { class: 'ai-translate-box' });
  let activeKey = null;
  let firstTab = null;
  function renderTranslateControls() {
    translateBox.innerHTML = '';
    if (!state.user) return;
    if (!state.aiSettings.has_key) {
      translateBox.append(
        el('button', {
          class: 'ai-translate-link',
          title: i18n.t('country.translate_tooltip'),
          onclick: openAiSettingsModal,
        }, `🌐 ${i18n.t('country.translate_setup_prompt')}`)
      );
      return;
    }
    const btn = el('button', {
      class: 'ai-translate-link',
      title: i18n.t('country.translate_tooltip'),
      onclick: async () => {
        const originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = i18n.t('ai.translating');
        try {
          const result = await api('/ai/translate-country-profile', {
            method: 'POST',
            body: JSON.stringify({ country_id: country.id, field: activeKey, target_lang: i18n.effectiveLang() }),
          });
          body.textContent = result.text;
          const revertBtn = el('button', {
            class: 'ai-translate-link',
            onclick: () => { body.textContent = profile[activeKey]; revertBtn.remove(); },
          }, i18n.t('detail.see_original'));
          translateBox.append(revertBtn);
        } catch (err) {
          showToast(friendlyErrorMessage(err));
        } finally {
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      },
    }, `🌐 ${i18n.t('country.translate_button')}`);
    translateBox.append(btn);
  }
  for (const [key, labelKey, icon] of COUNTRY_PROFILE_TABS) {
    if (!profile[key]) continue;
    const btn = el('button', {
      class: 'country-sheet-tab',
      onclick: () => {
        tabs.querySelectorAll('.country-sheet-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        body.textContent = profile[key];
        activeKey = key;
        renderTranslateControls();
      },
    }, `${icon} ${i18n.t(labelKey)}`);
    tabs.append(btn);
    if (!firstTab) firstTab = { btn, key };
  }
  if (!firstTab) {
    container.append(el('p', { class: 'country-sheet-soon' }, i18n.t('country.profile_soon')));
    return;
  }
  container.append(
    el('p', { class: 'country-sheet-disclaimer' }, i18n.t('country.profile_disclaimer')),
    tabs, body, translateBox
  );
  firstTab.btn.classList.add('active');
  body.textContent = profile[firstTab.key];
  activeKey = firstTab.key;
  renderTranslateControls();
}
// ---------- Opportunités d'affaires ----------
async function loadEconomicStats(country) {
  const container = document.getElementById('economicStats');
  if (!container) return;
  container.innerHTML = '';
  let stats;
  try {
    stats = await api(`/countries/${country.id}/economic-stats`);
  } catch {
    return; // section reste vide si l'appel échoue, pas de message d'erreur intrusif
  }
  if (document.getElementById('countryModal').hidden) return; // fermé entre-temps
  const figures = [
    ['gdp_usd', 'gdp_year', i18n.t('stats_econ.gdp'), (v) => formatCompactCurrency(v, 'USD')],
    ['gdp_per_capita_usd', 'gdp_per_capita_year', i18n.t('stats_econ.gdp_per_capita'), (v) => formatCompactCurrency(v, 'USD')],
    ['gdp_growth_pct', 'gdp_growth_year', i18n.t('stats_econ.gdp_growth'), (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`],
    ['unemployment_pct', 'unemployment_year', i18n.t('stats_econ.unemployment'), (v) => `${v.toFixed(1)}%`],
    ['inflation_pct', 'inflation_year', i18n.t('stats_econ.inflation'), (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`],
  ];
  const available = figures.filter(([key]) => stats[key] !== null && stats[key] !== undefined);
  if (available.length === 0) {
    container.append(
      el('h3', { class: 'economic-stats-title' }, `📊 ${i18n.t('stats_econ.title')}`),
      el('p', { class: 'economic-stats-empty' }, i18n.t('stats_econ.unavailable'))
    );
    return;
  }
  container.append(
    el('h3', { class: 'economic-stats-title' }, `📊 ${i18n.t('stats_econ.title')}`),
    el('div', { class: 'economic-stats-grid' }, available.map(([key, yearKey, label, formatter]) =>
      el('div', { class: 'economic-stat-card' }, [
        el('span', { class: 'economic-stat-value' }, formatter(stats[key])),
        el('span', { class: 'economic-stat-label' }, label),
        el('span', { class: 'economic-stat-year' }, String(stats[yearKey])),
      ])
    )),
    el('p', { class: 'economic-stats-source' }, i18n.t('stats_econ.source'))
  );
}
function formatCompactCurrency(value, currency) {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)} T${currency === 'USD' ? '$' : currency}`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)} Md${currency === 'USD' ? '$' : currency}`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)} M${currency === 'USD' ? '$' : currency}`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)} k${currency === 'USD' ? '$' : currency}`;
  return `${value.toFixed(0)} ${currency}`;
}
async function loadBusinessOpportunities(country) {
  const container = document.getElementById('businessOpportunities');
  if (!container) return;
  container.innerHTML = '';
  container.append(el('h3', { class: 'business-opp-title' }, `💼 ${i18n.t('business.title')}`));
  let data;
  try {
    data = await api(`/business-opportunities?country_id=${country.id}`);
  } catch {
    return;
  }
  if (document.getElementById('countryModal').hidden) return; // fermé entre-temps
  const nothing = data.listings.length === 0 && data.events.length === 0 && data.job_offers_count === 0;
  if (nothing) {
    container.append(el('p', { class: 'business-opp-empty' }, i18n.t('business.empty')));
  }
  if (data.job_offers_count > 0) {
    container.append(
      el('button', {
        class: 'business-opp-jobs-link',
        onclick: () => {
          document.getElementById('countryModal').hidden = true;
          const target = document.getElementById('stateGrid').hidden ? document.getElementById('cityGrid') : document.getElementById('stateGrid');
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      }, `👥 ${i18n.t('business.job_offers_count', { count: data.job_offers_count })}`)
    );
  }
  if (data.listings.length > 0) {
    container.append(
      el('div', { class: 'business-opp-listings' }, data.listings.map((l) => renderListingCard(l)))
    );
  }
  if (data.events.length > 0) {
    container.append(
      el('div', { class: 'business-opp-events' }, data.events.map((ev) => {
        const range = ev.end_date && ev.end_date !== ev.event_date
          ? `${formatEventDate(ev.event_date)} – ${formatEventDate(ev.end_date)}`
          : formatEventDate(ev.event_date);
        return el('div', { class: 'event-card' }, [
          el('div', { class: 'event-card-date' }, range),
          el('div', { class: 'event-card-body' }, [
            el('div', { class: 'event-card-title' }, ev.title),
            el('div', { class: 'event-card-meta' }, [ev.location_name, ev.city_name].filter(Boolean).join(' · ')),
            ev.external_link ? el('a', { class: 'event-card-link', href: ev.external_link, target: '_blank', rel: 'noopener' }, i18n.t('business.event_more_info')) : null,
          ]),
        ]);
      }))
    );
  }
  container.append(
    el('button', { class: 'btn btn--ghost btn--small', onclick: () => openEventModal(country) }, `+ ${i18n.t('business.propose_event')}`)
  );
}
function formatEventDate(dateStr) {
  return new Date(dateStr).toLocaleDateString();
}
function collapseMapOnce() {
  const wrap = document.querySelector('.hero-and-map');
  if (!wrap || wrap.dataset.collapsed) return;
  wrap.dataset.collapsed = '1';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  wrap.style.maxHeight = wrap.scrollHeight + 'px';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      wrap.classList.add('is-collapsed');
      wrap.style.maxHeight = '0px';
    });
  });
}
function reopenMap() {
  const wrap = document.querySelector('.hero-and-map');
  if (wrap) {
    wrap.classList.remove('is-collapsed');
    wrap.style.maxHeight = '';
    delete wrap.dataset.collapsed;
  }
  resetExplore();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function selectCountry(country, { openSheet = true } = {}) {
  document.body.classList.add('atlas-engaged');
  collapseMapOnce();
  setExploreStageVisibility('country');
  showSearchMode(false);
  stopCityClock();
  state.selectedCountry = country;
  state.selectedState = null;
  state.selectedCity = null;
  trackRecentPlace({ type: 'country', id: country.id, countryId: country.id, iso2: country.iso2, name: country.name });
  document.getElementById('countrySearchInput').value = countryLabel(country);
  const activeCountryHeading = document.getElementById('activeCountryHeading');
  if (activeCountryHeading) { activeCountryHeading.textContent = countryLabel(country); activeCountryHeading.hidden = false; }
  const showCountrySheetBtn = document.getElementById('showCountrySheetBtn');
  if (showCountrySheetBtn) showCountrySheetBtn.hidden = false;
  highlightCountryOnMap(country.iso_numeric);
  refreshCategoryOptionsForCountry(country.id, document.getElementById('categoryFilter'), { withAllOption: true, valueKey: 'slug' });
  loadFeatured();
  if (openSheet) openCountrySheet(country);
  const stateGrid = document.getElementById('stateGrid');
  const cityGrid = document.getElementById('cityGrid');
  stateGrid.innerHTML = '';
  cityGrid.innerHTML = '';
  cityGrid.hidden = true;
  if (country.is_federal) {
    document.getElementById('coordEyebrow').textContent = `${countryLabel(country).toUpperCase()} — ${i18n.t('eyebrow.choose_state_suffix')}`;
    const states = await api(`/countries/${country.id}/states`);
    state.lastStates = states;
    state.lastCities = null;
    renderStateTiles(states);
  } else {
    stateGrid.hidden = true;
    state.lastStates = null;
    document.getElementById('coordEyebrow').textContent = `${countryLabel(country).toUpperCase()} — ${i18n.t('eyebrow.choose_city_suffix')}`;
    const cities = await api(`/countries/${country.id}/cities`);
    state.lastCities = cities;
    renderCityTiles(cities);
  }
  document.getElementById('breadcrumb').hidden = false;
  renderBreadcrumb();
  document.getElementById('listingsHeader').hidden = true;
  document.getElementById('listingGrid').hidden = true;
  document.getElementById('breadcrumb').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function renderStateTiles(states) {
  const stateGrid = document.getElementById('stateGrid');
  stateGrid.innerHTML = '';
  stateGrid.hidden = false;
  for (const st of states) {
    stateGrid.append(
      el('button', { class: 'tile', onclick: () => selectState(st) }, [
        el('span', { class: 'tile-name' }, st.name),
        el('span', { class: 'tile-meta' }, i18n.t('tile.meta_country', { cities: st.city_count, listings: st.listing_count })),
      ])
    );
  }
}
async function selectState(st) {
  state.selectedState = st;
  state.selectedCity = null;
  document.getElementById('coordEyebrow').textContent = `${st.name.toUpperCase()}, ${countryLabel(state.selectedCountry).toUpperCase()} — ${i18n.t('eyebrow.choose_city_suffix')}`;
  const cities = await api(`/states/${st.id}/cities`);
  state.lastCities = cities;
  renderCityTiles(cities);
  renderBreadcrumb();
  document.getElementById('listingsHeader').hidden = true;
  document.getElementById('listingGrid').hidden = true;
  document.getElementById('cityGrid').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function renderCityTiles(cities) {
  const cityGrid = document.getElementById('cityGrid');
  cityGrid.innerHTML = '';
  cityGrid.hidden = false;
  const missingNotice = document.getElementById('cityMissingNotice');
  if (missingNotice) missingNotice.hidden = false;
  for (const city of cities) {
    const isFav = state.favoriteCityIds && state.favoriteCityIds.has(city.id);
    cityGrid.append(
      el('div', { class: 'tile', style: 'position:relative;' }, [
        el('button', { style: 'all:unset;cursor:pointer;display:block;width:100%;', onclick: () => selectCity(city) }, [
          el('span', { class: 'tile-name' }, city.name),
          el('span', { class: 'tile-meta' }, i18n.t('tile.meta_city', { listings: city.listing_count })),
        ]),
        el('button', {
          class: `favorite-city-btn ${isFav ? 'is-active' : ''}`,
          'aria-label': isFav ? i18n.t('destinations.remove') : i18n.t('destinations.add'),
          onclick: (e) => { e.stopPropagation(); toggleFavoriteCity(city.id, e.target); },
        }, isFav ? '♥' : '♡'),
      ])
    );
  }
}
async function selectCity(city) {
  state.selectedCity = city;
  trackRecentPlace({ type: 'city', id: city.id, countryId: state.selectedCountry ? state.selectedCountry.id : null, name: city.name, countryName: state.selectedCountry ? countryLabel(state.selectedCountry) : '' });
  setExploreStageVisibility('city');
  document.getElementById('coordEyebrow').textContent = `${city.name.toUpperCase()}, ${countryLabel(state.selectedCountry).toUpperCase()}`;
  renderBreadcrumb();
  document.getElementById('listingsHeader').hidden = false;
  document.getElementById('listingsTitle').textContent = `${i18n.t('listings.title_prefix')} ${city.name}`;
  startCityClock(city.timezone);
  await refreshListings();
  document.getElementById('listingsHeader').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  bc.innerHTML = '';
  const crumbs = [];
  if (state.selectedState) {
    crumbs.push(el('button', { onclick: () => selectState(state.selectedState) }, state.selectedState.name));
  }
  if (state.selectedCity) {
    crumbs.push(el('span', {}, state.selectedCity.name));
  }
  crumbs.forEach((node, i) => {
    if (i > 0) bc.append(document.createTextNode(' / '));
    bc.append(node);
  });
}
function resetExplore() {
  setExploreStageVisibility('landing');
  const activeCountryHeading = document.getElementById('activeCountryHeading');
  if (activeCountryHeading) { activeCountryHeading.hidden = true; activeCountryHeading.textContent = ''; }
  const showCountrySheetBtn = document.getElementById('showCountrySheetBtn');
  if (showCountrySheetBtn) showCountrySheetBtn.hidden = true;
  state.selectedCountry = null;
  state.selectedState = null;
  state.selectedCity = null;
  loadFeatured();
  stopCityClock();
  document.getElementById('coordEyebrow').textContent = `48.8566° N · 2.3522° E`;
  document.getElementById('countrySearchInput').value = '';
  document.getElementById('stateGrid').hidden = true;
  document.getElementById('cityGrid').hidden = true;
  document.getElementById('breadcrumb').hidden = true;
  document.getElementById('listingsHeader').hidden = true;
  document.getElementById('cityMiniMap').hidden = true;
  document.getElementById('listingGrid').hidden = true;
  highlightCountryOnMap(null);
}
function showSearchMode(active) {
  document.getElementById('searchResultsSection').hidden = !active;
  document.getElementById('countrySection').hidden = active;
  document.getElementById('featuredSection').hidden = active || document.getElementById('featuredGrid').children.length === 0;
  document.getElementById('categoryBreadcrumb').hidden = true;
  document.getElementById('categoryBrowseFilters').hidden = true;
  if (active) {
    document.getElementById('stateGrid').hidden = true;
    document.getElementById('cityGrid').hidden = true;
    document.getElementById('breadcrumb').hidden = true;
    document.getElementById('listingsHeader').hidden = true;
    document.getElementById('listingGrid').hidden = true;
    document.getElementById('cityMiniMap').hidden = true;
  }
}
document.getElementById('globalSearchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('globalSearchInput').value.trim();
  if (!q) return;
  document.body.classList.add('atlas-engaged'); collapseMapOnce();
  resetExplore();
  showSearchMode(true);
  document.getElementById('searchResultsTitle').textContent = i18n.t('search.results_title', { q });
  const grid = document.getElementById('searchResultsGrid');
  grid.innerHTML = '';
  try {
    const results = await api(`/listings/search?q=${encodeURIComponent(q)}`);
    state.lists.search = results;
    if (results.length === 0) {
      grid.append(el('div', { class: 'empty-state' }, i18n.t('empty.no_search_results')));
    } else {
      renderCardsInto('searchResultsGrid', results);
    }
  } catch {
    grid.append(el('div', { class: 'empty-state' }, i18n.t('empty.search_failed')));
  }
  document.getElementById('searchResultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('clearSearchBtn').addEventListener('click', () => {
  document.getElementById('globalSearchInput').value = '';
  showSearchMode(false);
});
async function refreshListings() {
  if (!state.selectedCity) return;
  const params = new URLSearchParams();
  const category = document.getElementById('categoryFilter').value;
  const subcategory = document.getElementById('subcategoryFilter').value;
  const type = document.getElementById('typeFilter').value;
  const sort = document.getElementById('sortFilter').value;
  const q = document.getElementById('searchInput').value.trim();
  const secondhandOnly = document.getElementById('secondhandFilterCheckbox').checked;
  if (category) params.set('category', category);
  if (subcategory) params.set('subcategory', subcategory);
  if (type) params.set('type', type);
  if (sort) params.set('sort', sort);
  if (q) params.set('q', q);
  if (secondhandOnly) params.set('secondhand', '1');
  const listings = await api(`/cities/${state.selectedCity.id}/listings?${params.toString()}`);
  state.currentListings = listings;
  state.lists.city = listings;
  const grid = document.getElementById('listingGrid');
  grid.hidden = false;
  renderCardsInto('listingGrid', listings);
  renderCityMiniMap(listings);
}
function hashListingId(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function renderCityMiniMap(listings) {
  const box = document.getElementById('cityMiniMap');
  if (!listings || listings.length === 0) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '';
  const W = 600, H = 150;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '150');
  for (let x = 30; x < W; x += 55) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x); line.setAttribute('y1', 0); line.setAttribute('x2', x); line.setAttribute('y2', H);
    line.setAttribute('stroke', 'rgba(241,233,216,0.06)'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }
  for (let y = 20; y < H; y += 35) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', 0); line.setAttribute('y1', y); line.setAttribute('x2', W); line.setAttribute('y2', y);
    line.setAttribute('stroke', 'rgba(241,233,216,0.06)'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }
  for (const l of listings.slice(0, 24)) {
    const h = hashListingId(l.id);
    const x = 24 + (h % (W - 48));
    const y = 18 + ((Math.floor(h / 97)) % (H - 36));
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'mini-map-pin');
    g.setAttribute('transform', `translate(${x},${y})`);
    g.addEventListener('click', () => openListingDetail(l.id));
    const glow = document.createElementNS(svgNS, 'circle');
    glow.setAttribute('r', '5');
    glow.setAttribute('class', 'mini-map-pin-glow');
    g.appendChild(glow);
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('r', '5');
    g.appendChild(circle);
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = l.title;
    g.appendChild(title);
    svg.appendChild(g);
  }
  box.append(svg, el('p', { class: 'city-mini-map-caption' }, i18n.t('map.mini_map_caption', { city: state.selectedCity.name })));
}
document.getElementById('typeFilter').addEventListener('change', refreshListings);
document.getElementById('sortFilter').addEventListener('change', refreshListings);
document.getElementById('secondhandFilterCheckbox').addEventListener('change', refreshListings);
document.getElementById('searchInput').addEventListener('input', debounce(refreshListings, 300));
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
async function uploadImageFile(file) {
  if (file.size > 5_000_000) throw new Error(i18n.t('upload.too_large'));
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const res = await api('/uploads', { method: 'POST', body: JSON.stringify({ data: base64, mime: file.type }) });
  return res.url;
}
function proBadge(tier) {
  if (!tier) return null;
  return el('span', { class: `pro-badge pro-badge--${tier}` }, `⭐ ${i18n.t(`pro.tier_${tier}`)}`);
}
/** Formate une plage de dates pour l'affichage — gère le cas d'une seule
 * date renseignée (pas de date de fin précisée) sans planter. */
/** Traduit le code interne du type de prix (ex. "par_nuit") en libellé
 * affichable ("Par nuit"), via les clés i18n existantes du formulaire. */
/** Traduit un code d'équipement (ex. "wifi") en icône + libellé affichable. */
function amenityLabel(code) {
  const map = {
    wifi: ['📶', 'publish.amenity_wifi'], pool: ['🏊', 'publish.amenity_pool'],
    air_conditioning: ['❄️', 'publish.amenity_ac'], parking: ['🅿️', 'publish.amenity_parking'],
    sea_view: ['🌊', 'publish.amenity_sea_view'], breakfast: ['🥐', 'publish.amenity_breakfast'],
  };
  const entry = map[code];
  return entry ? `${entry[0]} ${i18n.t(entry[1])}` : code;
}
function priceTypeLabel(priceType) {
  const map = {
    par_nuit: 'publish.price_type_night', par_personne: 'publish.price_type_person',
    par_enfant: 'publish.price_type_child', forfait_groupe: 'publish.price_type_group',
    par_jour: 'publish.price_type_day', par_heure: 'publish.price_type_hour',
    par_trajet: 'publish.price_type_trip',
  };
  return map[priceType] ? i18n.t(map[priceType]) : '';
}
function formatListingDateRange(l) {
  if (!l.date_start) return '';
  const start = new Date(l.date_start).toLocaleDateString();
  if (!l.date_end || l.date_end === l.date_start) return start;
  const end = new Date(l.date_end).toLocaleDateString();
  return `${i18n.t('detail.date_range_from')} ${start} ${i18n.t('detail.date_range_to')} ${end}`;
}
/** Une annonce est "fraîche" si publiée il y a moins de 24h — utilisé pour
 * le badge et pour distinguer les nouvelles arrivées sans dépendre du tri. */
function isFreshListing(createdAt) {
  if (!createdAt) return false;
  return (Date.now() - new Date(createdAt).getTime()) < 24 * 60 * 60 * 1000;
}
function renderListingCard(l) {
  const img = (l.images && l.images[0]) || '';
  const natureLabel = l.subcategory_name ? `${l.category_icon} ${listingSubcategoryLabel(l)}` : `${l.category_icon} ${listingCategoryLabel(l)}`;
  const isFav = state.favoriteIds.has(l.id);
  const favBtn = el('button', {
    class: `favorite-btn ${isFav ? 'is-active' : ''}`,
    'aria-label': i18n.t('favorites.toggle'),
    onclick: (e) => { e.stopPropagation(); toggleFavorite(l.id, favBtn); },
  }, isFav ? '♥' : '♡');
  return el('article', { class: `card ${l.is_demo ? 'card--demo' : ''}`, onclick: () => openListingDetail(l.id) }, [
    l.is_demo ? el('div', { class: 'demo-watermark' }, i18n.t('demo.watermark')) : null,
    l.transaction_completed ? el('div', { class: 'transaction-stamp' }, l.listing_type === 'location' ? i18n.t('mine.stamp_rented') : i18n.t('mine.stamp_sold')) : null,
    img ? el('img', { class: 'card-img', src: img, alt: l.title, loading: 'lazy' }) : el('div', { class: 'card-img' }),
    l.is_secondhand ? el('span', { class: 'secondhand-badge' }, `♻️ ${i18n.t('badge.secondhand')}`) : null,
    l.date_start ? el('span', { class: 'tourism-dates-badge' }, `📅 ${formatListingDateRange(l)}`) : null,
    l.price_promo ? el('span', { class: 'tourism-promo-badge' }, `🔥 ${fmtPrice(l.price_promo, l.currency)}${l.price_type ? ' / ' + priceTypeLabel(l.price_type) : ''}`) : null,
    isFreshListing(l.created_at) ? el('span', { class: 'fresh-badge' }, `✨ ${i18n.t('badge.fresh')}`) : null,
    favBtn,
    el('div', { class: 'card-body' }, [
      el('span', { class: `card-tag ${(l.listing_type === 'location' || l.listing_type === 'demande_emploi') ? 'card-tag--location' : ''} ${l.listing_type === 'achat' ? 'card-tag--achat' : ''}` }, `${natureLabel} · ${listingTypeLabel(l.listing_type)}`),
      el('h3', { class: 'card-title' }, l.title),
      l.is_professional ? el('div', { style: 'margin:4px 0;' }, [
        l.company_logo_url ? el('img', { class: 'company-logo', src: l.company_logo_url, alt: l.company_name || '' }) : null,
        el('span', { style: 'font-size:0.78rem;color:var(--brass-300);font-weight:600;' }, l.company_name || ''),
        proBadge(l.pro_tier),
      ]) : null,
      el('span', { class: 'card-place' }, `${l.city_name}${l.country_name ? ', ' + listingCountryLabel(l) : ''}`),
      el('span', { class: 'card-price' }, priceLabel(l)),
    ]),
  ]);
}
/** Anime un sceau de cire qui apparaît, tourne et s'estompe sur le
 * bouton favori cliqué — remplace le simple changement de coeur par
 * quelque chose qui rappelle l'identité "carnet de voyage" du site. */
function playWaxSealAnimation(btnEl) {
  const rect = btnEl.getBoundingClientRect();
  const seal = document.createElement('div');
  seal.className = 'wax-seal-fx';
  seal.textContent = '❤';
  seal.style.left = `${rect.left + rect.width / 2}px`;
  seal.style.top = `${rect.top + rect.height / 2}px`;
  document.body.append(seal);
  seal.addEventListener('animationend', () => seal.remove());
}
async function toggleFavorite(listingId, btnEl) {
  if (!state.user) { openAuthModal('login'); return; }
  const isFav = state.favoriteIds.has(listingId);
  try {
    if (isFav) {
      await api(`/favorites/${listingId}`, { method: 'DELETE' });
      state.favoriteIds.delete(listingId);
    } else {
      await api('/favorites', { method: 'POST', body: JSON.stringify({ listing_id: listingId }) });
      state.favoriteIds.add(listingId);
    }
    if (btnEl) {
      btnEl.classList.toggle('is-active', !isFav);
      btnEl.textContent = !isFav ? '♥' : '♡';
      if (!isFav) playWaxSealAnimation(btnEl);
    }
    const detailBtn = document.getElementById('detailFavoriteBtn');
    if (detailBtn && Number(detailBtn.dataset.listingId) === listingId) {
      detailBtn.classList.toggle('is-active', !isFav);
      detailBtn.textContent = !isFav ? i18n.t('favorites.remove') : i18n.t('favorites.add');
      if (!isFav) playWaxSealAnimation(detailBtn);
    }
    if (!document.getElementById('view-favorites').hidden) loadFavorites();
  } catch (e) {
    showToast(friendlyErrorMessage(e));
  }
}
async function loadFavoriteIds() {
  if (!state.user) { state.favoriteIds = new Set(); return; }
  try {
    const ids = await api('/favorites/ids');
    state.favoriteIds = new Set(ids);
  } catch {
    state.favoriteIds = new Set();
  }
}
/** Charge les pays/villes favoris de l'utilisateur et remplit la section
 * "Mes destinations" de l'accueil — un accès direct en un clic, en plus
 * (jamais à la place) du parcours pays -> ville habituel. */
async function loadFavoriteDestinations() {
  const section = document.getElementById('favoriteDestinationsSection');
  if (!state.user) {
    state.favoriteCountryIds = new Set();
    state.favoriteCityIds = new Set();
    section.hidden = true;
    return;
  }
  try {
    const { countries, cities } = await api('/me/favorite-destinations');
    state.favoriteCountryIds = new Set(countries.map((c) => c.id));
    state.favoriteCityIds = new Set(cities.map((c) => c.id));
    const grid = document.getElementById('favoriteDestinationsGrid');
    grid.innerHTML = '';
    if (countries.length === 0 && cities.length === 0) { section.hidden = true; return; }
    section.hidden = false;
    for (const c of countries) {
      grid.append(el('button', { class: 'tile', onclick: () => { const full = state.countries.find((x) => x.id === c.id); if (full) selectCountry(full); } }, [
        el('span', { class: 'tile-name' }, `♥ ${countryLabel(c)}`),
      ]));
    }
    for (const c of cities) {
      grid.append(el('button', { class: 'tile', onclick: async () => {
        const full = state.countries.find((x) => x.id === c.country_id);
        if (!full) return;
        await selectCountry(full, { openSheet: false });
        const cityFull = (state.lastCities || []).find((x) => x.id === c.id);
        if (cityFull) selectCity(cityFull);
      } }, [
        el('span', { class: 'tile-name' }, `♥ ${c.name}`),
        el('span', { class: 'tile-meta' }, countryLabel(c)),
      ]));
    }
  } catch {
    section.hidden = true;
  }
}
async function toggleFavoriteCountry(countryId, btnEl) {
  if (!state.user) { openAuthModal('login'); return; }
  const isFav = state.favoriteCountryIds.has(countryId);
  try {
    if (isFav) {
      await api(`/favorite-countries/${countryId}`, { method: 'DELETE' });
      state.favoriteCountryIds.delete(countryId);
    } else {
      await api('/favorite-countries', { method: 'POST', body: JSON.stringify({ country_id: countryId }) });
      state.favoriteCountryIds.add(countryId);
    }
    if (btnEl) {
      btnEl.classList.toggle('is-active', !isFav);
      btnEl.textContent = !isFav ? `♥ ${i18n.t('destinations.remove')}` : `♡ ${i18n.t('destinations.add')}`;
    }
    loadFavoriteDestinations();
  } catch (e) {
    showToast(e.message);
  }
}
async function toggleFavoriteCity(cityId, btnEl) {
  if (!state.user) { openAuthModal('login'); return; }
  const isFav = state.favoriteCityIds.has(cityId);
  try {
    if (isFav) {
      await api(`/favorite-cities/${cityId}`, { method: 'DELETE' });
      state.favoriteCityIds.delete(cityId);
    } else {
      await api('/favorite-cities', { method: 'POST', body: JSON.stringify({ city_id: cityId }) });
      state.favoriteCityIds.add(cityId);
    }
    if (btnEl) {
      btnEl.classList.toggle('is-active', !isFav);
      btnEl.textContent = !isFav ? '♥' : '♡';
    }
    loadFavoriteDestinations();
  } catch (e) {
    showToast(e.message);
  }
}
async function loadFavorites() {
  try {
    const favorites = await api('/favorites');
    state.lists.favorites = favorites;
    renderCardsInto('favoritesGrid', favorites);
  } catch (e) {
    showToast(friendlyErrorMessage(e));
  }
}
// ---------- Alertes de recherche ----------
let pendingAlertCriteria = null;
function currentCityFilterCriteria() {
  if (!state.selectedCity) return null;
  const category = findCategoryBySlug(document.getElementById('categoryFilter').value);
  const subSelect = document.getElementById('subcategoryFilter');
  const subSlug = subSelect.value;
  const subcategory = category && subSlug ? category.subcategories.find((s) => s.slug === subSlug) : null;
  return {
    country_id: state.selectedCountry ? state.selectedCountry.id : null,
    city_id: state.selectedCity.id,
    category_id: category ? category.id : null,
    subcategory_id: subcategory ? subcategory.id : null,
    listing_type: document.getElementById('typeFilter').value || null,
    keyword: document.getElementById('searchInput').value.trim() || null,
  };
}
function currentCategoryBrowseCriteria() {
  const { category, subcategory, type } = state.categoryBrowse;
  if (!category) return null;
  const sub = subcategory ? category.subcategories.find((s) => s.slug === subcategory) : null;
  return {
    country_id: null,
    city_id: null,
    category_id: category.id,
    subcategory_id: sub ? sub.id : null,
    listing_type: type || null,
    keyword: null,
  };
}
function openSaveAlertModal(criteria) {
  if (!state.user) { openAuthModal('login'); return; }
  pendingAlertCriteria = criteria;
  document.getElementById('saveAlertForm').reset();
  document.getElementById('saveAlertError').hidden = true;
  document.getElementById('saveAlertModal').hidden = false;
  document.getElementById('saveAlertLabelInput').focus();
}
document.getElementById('saveSearchBtn').addEventListener('click', () => openSaveAlertModal(currentCityFilterCriteria()));
document.getElementById('saveCategorySearchBtn').addEventListener('click', () => openSaveAlertModal(currentCategoryBrowseCriteria()));
document.getElementById('saveAlertForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('saveAlertError');
  errEl.hidden = true;
  try {
    await api('/saved-searches', {
      method: 'POST',
      body: JSON.stringify({ ...pendingAlertCriteria, label: fd.get('label'), email_alerts: fd.get('email_alerts') === 'on' }),
    });
    showToast(i18n.t('toast.alert_saved'));
    document.getElementById('saveAlertModal').hidden = true;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
async function refreshAlertsBadge() {
  if (!state.user) return;
  try {
    const { count } = await api('/saved-searches/unread-count');
    const badge = document.getElementById('alertsBadge');
    badge.textContent = String(count);
    badge.hidden = count === 0;
  } catch { /* silencieux */ }
}
// ---------- Partage façon carte postale ----------
function loadImageSafe(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
async function shareListingAsPostcard(listing) {
  const url = `${window.location.origin}/?listing=${listing.id}`;
  const shareText = i18n.t('share.postcard_text', { title: listing.title, city: listing.city_name });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0E1B2E';
    ctx.fillRect(0, 0, 1000, 600);
    if (listing.images && listing.images[0]) {
      try {
        const img = await loadImageSafe(listing.images[0]);
        ctx.drawImage(img, 40, 40, 500, 520);
      } catch { /* image indisponible, carte postale sans photo */ }
    }
    ctx.strokeStyle = '#C6A15B';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, 980, 580);
    ctx.fillStyle = '#F1E9D8';
    ctx.font = 'bold 34px Georgia, serif';
    wrapCanvasText(ctx, listing.title, 570, 110, 380, 40);
    ctx.font = '20px Georgia, serif';
    ctx.fillStyle = '#DDC48C';
    ctx.fillText(`${flagEmoji(listing.country_iso2 || '')} ${listing.city_name}, ${listingCountryLabel(listing)}`.trim(), 570, 200);
    ctx.font = 'bold 28px monospace';
    ctx.fillStyle = '#F1E9D8';
    ctx.fillText(priceLabel(listing), 570, 250);
    ctx.beginPath();
    ctx.arc(880, 500, 70, 0, Math.PI * 2);
    ctx.strokeStyle = '#B5482E';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = '13px monospace';
    ctx.fillStyle = '#B5482E';
    ctx.textAlign = 'center';
    ctx.fillText('QUICKATLAS', 880, 495);
    ctx.fillText((listing.city_name || '').toUpperCase(), 880, 517);
    ctx.textAlign = 'left';
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
    const file = new File([blob], 'quickatlas-annonce.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: listing.title, text: `${shareText}\n${url}` });
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'quickatlas-annonce.png';
    link.click();
    showToast(i18n.t('toast.postcard_downloaded'));
  } catch {
    if (navigator.share) {
      try { await navigator.share({ title: listing.title, text: shareText, url }); return; } catch { /* partage annulé */ }
    }
    navigator.clipboard.writeText(`${shareText} ${url}`);
    showToast(i18n.t('toast.link_copied'));
  }
}
function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let curY = y;
  for (const word of words) {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, curY);
      line = word + ' ';
      curY += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, curY);
}
// ---------- Passeport QuickAtlas ----------
async function loadPassport() {
  const box = document.getElementById('passportBook');
  box.innerHTML = '';
  try {
    const p = await api(`/users/${state.user.id}/passport`);
    const memberSince = new Date(p.member_since).toLocaleDateString();
    box.append(
      el('p', { class: 'passport-meta' }, `${i18n.t('passport.member_since')} ${memberSince}${p.review_count > 0 ? ` · ★ ${p.avg_rating} (${p.review_count})` : ''}`),
      el('p', { class: 'passport-stamps-title' }, i18n.t('passport.sold_title')),
      renderStampRow(p.countries_sold),
      el('p', { class: 'passport-stamps-title' }, i18n.t('passport.bought_title')),
      renderStampRow(p.countries_bought)
    );
  } catch (e) {
    box.append(el('p', { class: 'passport-empty' }, friendlyErrorMessage(e)));
  }
  document.getElementById('phoneInput').value = state.user.phone || '';
  const referralLink = `${window.location.origin}/?ref=${state.user.referral_code || ''}`;
  document.getElementById('referralLinkInput').value = referralLink;
  document.getElementById('referralCreditsText').textContent = i18n.t('passport.credits_balance', { count: state.user.free_boost_credits || 0 });
  renderProProfile();
}
function renderProProfile() {
  const box = document.getElementById('proProfileContent');
  box.innerHTML = '';
  const u = state.user;
  if (!u.is_professional) {
    box.append(
      el('button', { class: 'btn btn--primary btn--small', onclick: () => renderProProfileForm(box, {}) }, i18n.t('pro.become_professional'))
    );
    return;
  }
  const tierRow = el('div', { style: 'display:flex;gap:10px;align-items:center;margin:10px 0;' }, [
    u.company_logo_url ? el('img', { class: 'company-logo-detail', src: u.company_logo_url, alt: u.company_name || '' }) : null,
    el('div', {}, [
      el('div', { style: 'font-weight:700;font-size:1.05rem;' }, u.company_name),
      el('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:4px;' }, [
        proBadge(u.pro_tier),
        u.domain_verified ? el('span', { class: 'pro-domain-badge' }, `✓ ${i18n.t('pro.domain_verified')}`) : null,
      ]),
    ]),
  ]);
  const nextTierInfo = el('p', { class: 'form-hint' }, i18n.t('pro.next_tier_hint', { tier: i18n.t(`pro.tier_${u.pro_tier}`) }));
  const editBtn = el('button', { class: 'btn btn--ghost btn--small', onclick: () => renderProProfileForm(box, u) }, i18n.t('pro.edit_profile'));
  box.append(tierRow, nextTierInfo, editBtn);
}
function renderProProfileForm(box, current) {
  box.innerHTML = '';
  const nameInput = el('input', { type: 'text', name: 'company_name', value: current.company_name || '', placeholder: i18n.t('auth.company_name'), required: true });
  const websiteInput = el('input', { type: 'text', name: 'company_website', value: current.company_website || '', placeholder: 'monentreprise.com' });
  const logoPreview = el('img', { class: 'company-logo-detail', src: current.company_logo_url || '', style: current.company_logo_url ? '' : 'display:none;' });
  let logoUrl = current.company_logo_url || null;
  const logoInput = el('input', { type: 'file', accept: 'image/*', onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const uploaded = await uploadImageFile(file);
      logoUrl = uploaded;
      logoPreview.src = uploaded;
      logoPreview.style.display = '';
    } catch { showToast(i18n.t('toast.upload_failed')); }
  } });
  const errEl = el('p', { class: 'form-error', hidden: true });
  const saveBtn = el('button', { class: 'btn btn--primary btn--small', onclick: async () => {
    errEl.hidden = true;
    try {
      await api('/me/professional-profile', {
        method: 'PUT',
        body: JSON.stringify({ is_professional: true, company_name: nameInput.value, company_website: websiteInput.value, company_logo_url: logoUrl }),
      });
      const { user } = await api('/auth/me');
      state.user = { ...state.user, ...user };
      localStorage.setItem('atlas_user', JSON.stringify(state.user));
      showToast(i18n.t('pro.profile_saved'));
      renderProProfile();
    } catch (err) { errEl.textContent = friendlyErrorMessage(err); errEl.hidden = false; }
  } }, i18n.t('pro.save_profile'));
  box.append(
    el('div', { class: 'form-row' }, [el('label', {}, [el('span', {}, i18n.t('auth.company_name')), nameInput])]),
    el('div', { class: 'form-row' }, [el('label', {}, [el('span', {}, i18n.t('auth.company_website')), websiteInput])]),
    el('div', { class: 'form-row' }, [el('label', {}, [el('span', {}, i18n.t('pro.logo_label')), logoInput]), logoPreview]),
    errEl, saveBtn
  );
}
function renderStampRow(countries) {
  if (!countries || countries.length === 0) {
    return el('p', { class: 'passport-empty' }, i18n.t('passport.no_stamps'));
  }
  return el('div', { class: 'passport-stamps' }, countries.map((c, i) =>
    el('div', { class: 'passport-stamp', style: `--stamp-tilt: ${(i % 2 === 0 ? -1 : 1) * (2 + (i % 3))}deg` }, [
      el('span', { class: 'flag' }, flagEmoji(c.iso2)),
      el('span', { class: 'country-name' }, countryLabel(c)),
      el('span', { class: 'stamp-date' }, new Date(c.first_at).toLocaleDateString()),
    ])
  ));
}
document.getElementById('phoneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('phoneError');
  errEl.hidden = true;
  try {
    const result = await api('/me/phone', { method: 'PUT', body: JSON.stringify({ phone: fd.get('phone') }) });
    state.user.phone = result.phone;
    localStorage.setItem('atlas_user', JSON.stringify(state.user));
    showToast(i18n.t('toast.phone_saved'));
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
document.getElementById('copyReferralBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('referralLinkInput').value);
  showToast(i18n.t('toast.link_copied'));
});
async function loadAlerts() {
  const container = document.getElementById('alertsList');
  try {
    const searches = await api('/saved-searches');
    container.innerHTML = '';
    if (searches.length === 0) {
      container.append(el('p', { class: 'alert-empty' }, i18n.t('alerts.none')));
      return;
    }
    for (const s of searches) {
      const criteriaBits = [listingCountryLabel(s), s.city_name, listingCategoryLabel(s), listingSubcategoryLabel(s), s.listing_type ? listingTypeLabel(s.listing_type) : null, s.keyword ? `« ${s.keyword} »` : null].filter(Boolean);
      const matchesBox = el('div', { hidden: 'true' });
      const card = el('div', { class: 'alert-card' }, [
        el('div', { class: 'alert-card-top' }, [
          el('h3', { class: 'alert-card-label' }, s.label),
          s.unseen_count > 0 ? el('span', { class: 'alert-card-badge' }, i18n.t('alerts.new_count', { count: s.unseen_count })) : null,
        ]),
        el('p', { class: 'alert-card-criteria' }, criteriaBits.join(' · ') || i18n.t('alerts.all_criteria')),
        el('div', { class: 'alert-card-actions' }, [
          el('button', { class: 'btn btn--ghost btn--small', onclick: async () => {
            const hidden = matchesBox.hidden;
            matchesBox.hidden = !hidden;
            if (hidden) {
              const matches = await api(`/saved-searches/${s.id}/matches`);
              matchesBox.innerHTML = '';
              if (matches.length === 0) {
                matchesBox.append(el('p', { class: 'alert-empty' }, i18n.t('alerts.no_matches_yet')));
              } else {
                matchesBox.append(el('div', { class: 'alert-matches-grid' }, matches.map((l) => renderListingCard(l))));
              }
              refreshAlertsBadge();
              s.unseen_count = 0;
              card.querySelector('.alert-card-badge')?.remove();
            }
          } }, i18n.t('alerts.view_matches')),
          el('button', { class: 'btn btn--danger btn--small', onclick: async () => {
            await api(`/saved-searches/${s.id}`, { method: 'DELETE' });
            loadAlerts();
            showToast(i18n.t('toast.alert_deleted'));
          } }, i18n.t('alerts.delete')),
        ]),
        matchesBox,
      ]);
      container.append(card);
    }
  } catch (e) {
    container.innerHTML = '';
    showToast(friendlyErrorMessage(e));
  }
}
// ---------- Vus récemment (localStorage, sans backend) ----------
const RECENTLY_VIEWED_KEY = 'atlas_recently_viewed';
const RECENTLY_VIEWED_MAX = 8;
const RECENT_PLACES_KEY = 'atlas_recent_places';
const RECENT_PLACES_MAX = 6;
/** Mémorise automatiquement les derniers pays/villes visités (sans action
 * de l'utilisateur, contrairement aux favoris) — permet de reprendre
 * l'exploration là où elle s'était arrêtée. */
function trackRecentPlace(place) {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(RECENT_PLACES_KEY) || '[]'); } catch { items = []; }
  items = items.filter((i) => !(i.type === place.type && i.id === place.id));
  items.unshift(place);
  items = items.slice(0, RECENT_PLACES_MAX);
  localStorage.setItem(RECENT_PLACES_KEY, JSON.stringify(items));
}
function renderRecentPlaces() {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(RECENT_PLACES_KEY) || '[]'); } catch { items = []; }
  const section = document.getElementById('recentPlacesSection');
  if (items.length === 0) { section.hidden = true; return; }
  section.hidden = false;
  const grid = document.getElementById('recentPlacesGrid');
  grid.innerHTML = '';
  for (const p of items) {
    grid.append(el('button', { class: 'tile', onclick: async () => {
      const full = state.countries.find((x) => x.id === p.countryId);
      if (!full) return;
      if (p.type === 'country') { selectCountry(full); return; }
      await selectCountry(full, { openSheet: false });
      const cityFull = (state.lastCities || []).find((x) => x.id === p.id);
      if (cityFull) selectCity(cityFull);
    } }, [
      el('span', { class: 'tile-name' }, p.type === 'country' ? countryLabel({ iso2: p.iso2, name: p.name }) : p.name),
      p.type === 'city' ? el('span', { class: 'tile-meta' }, p.countryName) : null,
    ]));
  }
}
function trackRecentlyViewed(listing) {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(RECENTLY_VIEWED_KEY) || '[]'); } catch { items = []; }
  items = items.filter((i) => i.id !== listing.id);
  items.unshift({
    id: listing.id, title: listing.title, price: listing.price, currency: listing.currency,
    listing_type: listing.listing_type, images: listing.images, category_icon: listing.category_icon,
    category_name: listing.category_name, subcategory_name: listing.subcategory_name, category_slug: listing.category_slug, subcategory_slug: listing.subcategory_slug,
    city_name: listing.city_name, country_name: listing.country_name, country_iso2: listing.country_iso2,
  });
  items = items.slice(0, RECENTLY_VIEWED_MAX);
  localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(items));
}
function renderRecentlyViewed() {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(RECENTLY_VIEWED_KEY) || '[]'); } catch { items = []; }
  const section = document.getElementById('recentlyViewedSection');
  if (items.length === 0) { section.hidden = true; return; }
  section.hidden = false;
  renderCardsInto('recentlyViewedGrid', items);
}
async function loadSimilarListings(listingId, containerEl) {
  try {
    const similar = await api(`/listings/${listingId}/similar`);
    if (similar.length === 0) { containerEl.innerHTML = ''; return; }
    containerEl.innerHTML = '';
    containerEl.append(
      el('h3', {}, i18n.t('detail.similar_title')),
      el('div', { class: 'similar-listings-grid' }, similar.map((l) => renderListingCard(l)))
    );
  } catch {
    containerEl.innerHTML = '';
  }
}
/** "Sur le chemin" — annonces similaires dans d'autres villes du même
 * pays, présentées comme des étapes d'un itinéraire (esprit carnet de
 * voyage) plutôt qu'une simple grille de cartes. */
async function loadOnThePath(listingId, containerEl) {
  try {
    const nearby = await api(`/listings/${listingId}/on-the-path`);
    if (nearby.length === 0) { containerEl.innerHTML = ''; return; }
    containerEl.innerHTML = '';
    containerEl.append(
      el('h3', {}, `🧭 ${i18n.t('detail.on_the_path_title')}`),
      el('p', { class: 'on-the-path-sub' }, i18n.t('detail.on_the_path_sub')),
      el('div', { class: 'on-the-path-route' },
        nearby.map((l, i) => el('div', { class: 'on-the-path-stop' }, [
          el('span', { class: 'on-the-path-waypoint' }, `📍 ${l.city_name}`),
          el('div', { onclick: () => openListingDetail(l.id) }, renderListingCard(l)),
          el('button', { class: 'compare-link', onclick: (e) => { e.stopPropagation(); openCompareModal(currentListingId, l.id); } }, `⚖️ ${i18n.t('compare.button')}`),
        ]))
      )
    );
  } catch {
    containerEl.innerHTML = '';
  }
}
// ---------- Détail d'annonce ----------
async function autoTranslateListingIfNeeded(listing) {
  const viewerLang = i18n.effectiveLang();
  if (!listing.language || listing.language === viewerLang) return;
  try {
    const result = await api(`/listings/${listing.id}/translation?lang=${viewerLang}`);
    if (result.unavailable || result.same_language) return;
    const titleEl = document.getElementById('detailTitleText');
    const descEl = document.getElementById('detailDescriptionText');
    if (!titleEl || !descEl) return; // la personne a déjà changé de page
    const originalTitle = listing.title;
    const originalDescription = listing.description || i18n.t('detail.no_description');
    titleEl.childNodes[0].textContent = result.title;
    descEl.textContent = result.description || originalDescription;
    const banner = el('div', { class: 'translation-banner' }, [
      `🌐 ${i18n.t('detail.auto_translated')}`,
      el('button', { class: 'translation-toggle', onclick: (e) => {
        const showingOriginal = e.target.dataset.showingOriginal === 'true';
        titleEl.childNodes[0].textContent = showingOriginal ? result.title : originalTitle;
        descEl.textContent = showingOriginal ? (result.description || originalDescription) : originalDescription;
        e.target.textContent = showingOriginal ? i18n.t('detail.see_original') : i18n.t('detail.see_translation');
        e.target.dataset.showingOriginal = String(!showingOriginal);
      }, 'data-showing-original': 'false' }, i18n.t('detail.see_original')),
    ]);
    titleEl.insertAdjacentElement('afterend', banner);
  } catch {
    /* silencieux : l'annonce reste affichée dans sa langue d'origine */
  }
}
/** Ouvre la modale de comparaison entre deux annonces (récupérées
 * intégralement, pour disposer de tous les champs même si les cartes
 * d'origine n'en montraient qu'une partie). */
async function openCompareModal(idA, idB) {
  try {
    const [a, b] = await Promise.all([api(`/listings/${idA}`), api(`/listings/${idB}`)]);
    const body = document.getElementById('compareModalBody');
    body.innerHTML = '';
    const rows = [
      { label: i18n.t('compare.row_price'), val: (x) => priceLabel(x) },
      { label: i18n.t('compare.row_city'), val: (x) => x.city_name },
      { label: i18n.t('compare.row_capacity'), val: (x) => x.capacity_guests ? String(x.capacity_guests) : '—' },
      { label: i18n.t('compare.row_bedrooms'), val: (x) => x.bedrooms ? String(x.bedrooms) : '—' },
      { label: i18n.t('compare.row_amenities'), val: (x) => x.amenities_json ? JSON.parse(x.amenities_json).length + ' ' + i18n.t('compare.amenities_count') : '—' },
      { label: i18n.t('compare.row_dates'), val: (x) => x.date_start ? formatListingDateRange(x) : '—' },
    ];
    function renderColumn(x) {
      const col = el('div', { class: 'compare-col' }, [
        el('div', { class: 'compare-col-title' }, x.title),
        ...rows.map((r) => el('div', { class: 'compare-row' }, [
          el('span', {}, r.label),
          el('span', { class: 'compare-row-value' }, r.val(x)),
        ])),
        el('button', { class: 'btn btn--ghost btn--small', onclick: () => { document.getElementById('compareModal').hidden = true; openListingDetail(x.id); } }, i18n.t('compare.view_listing')),
      ]);
      return col;
    }
    body.append(renderColumn(a), renderColumn(b));
    document.getElementById('compareModal').hidden = false;
  } catch (e) {
    showToast(e.message);
  }
}
/** Construit la galerie de la fiche annonce : une seule image si une
 * seule photo, un carrousel navigable (flèches + puces) si plusieurs. */
function renderDetailGallery(images, title) {
  if (!images || images.length === 0) return el('div', { class: 'detail-img' });
  if (images.length === 1) return el('img', { class: 'detail-img', src: images[0], alt: title });
  let index = 0;
  const imgEl = el('img', { class: 'detail-img', src: images[0], alt: title });
  const dotsWrap = el('div', { class: 'gallery-dots' });
  function renderDots() {
    dotsWrap.innerHTML = '';
    images.forEach((_, i) => {
      dotsWrap.append(el('button', {
        class: `gallery-dot ${i === index ? 'is-active' : ''}`,
        'aria-label': `${i18n.t('detail.gallery_photo')} ${i + 1}`,
        onclick: (e) => { e.stopPropagation(); goTo(i); },
      }));
    });
  }
  function goTo(i) {
    index = (i + images.length) % images.length;
    imgEl.src = images[index];
    renderDots();
  }
  renderDots();
  const prevBtn = el('button', { class: 'gallery-arrow gallery-arrow--prev', 'aria-label': i18n.t('detail.gallery_prev'), onclick: (e) => { e.stopPropagation(); goTo(index - 1); } }, '‹');
  const nextBtn = el('button', { class: 'gallery-arrow gallery-arrow--next', 'aria-label': i18n.t('detail.gallery_next'), onclick: (e) => { e.stopPropagation(); goTo(index + 1); } }, '›');
  return el('div', { class: 'detail-gallery' }, [imgEl, prevBtn, nextBtn, dotsWrap]);
}
/** Mode exploration façon roulette du globe : tire une annonce au hasard
 * n'importe où sur le site, avec un effet "machine à sous" qui fait
 * défiler plusieurs cartes fictives avant de révéler le vrai tirage. */
let randomExploreCurrentListingId = null;
async function spinRandomExplore() {
  const body = document.getElementById('randomExploreBody');
  const viewBtn = document.getElementById('randomExploreViewBtn');
  viewBtn.disabled = true;
  body.innerHTML = '';
  const spinner = el('div', { class: 'random-explore-spinner' }, '🌍');
  body.append(spinner);
  let ticks = 0;
  const spinInterval = setInterval(() => {
    spinner.textContent = ['🌍', '🌎', '🌏'][ticks % 3];
    ticks++;
  }, 120);
  try {
    const [listing] = await Promise.all([
      api('/listings/random-explore'),
      new Promise((resolve) => setTimeout(resolve, 1100)),
    ]);
    clearInterval(spinInterval);
    randomExploreCurrentListingId = listing.id;
    const img = (listing.images && listing.images[0]) || '';
    body.innerHTML = '';
    body.append(
      el('div', { class: 'random-explore-flag' }, `${listing.category_icon} ${listing.city_name}, ${listingCountryLabel(listing)}`),
      img ? el('img', { class: 'random-explore-img', src: img, alt: listing.title }) : el('div', { class: 'random-explore-img' }),
      el('h3', {}, listing.title),
      el('p', { class: 'random-explore-price' }, priceLabel(listing)),
    );
    viewBtn.disabled = false;
  } catch (e) {
    clearInterval(spinInterval);
    body.innerHTML = '';
    body.append(el('p', {}, i18n.t('explore_random.error')));
  }
}
document.getElementById('randomExploreBtn').addEventListener('click', () => {
  document.getElementById('randomExploreModal').hidden = false;
  spinRandomExplore();
});
document.getElementById('randomExploreSpinAgainBtn').addEventListener('click', spinRandomExplore);
document.getElementById('randomExploreViewBtn').addEventListener('click', () => {
  document.getElementById('randomExploreModal').hidden = true;
  if (randomExploreCurrentListingId) openListingDetail(randomExploreCurrentListingId);
});
let currentListingId = null;
async function openListingDetail(id) {
  currentListingId = id;
  const l = await api(`/listings/${id}`);
  openListingSnapshot = { price: l.price, status: l.status };
  const updateBanner = document.getElementById('detailUpdateBanner');
  if (updateBanner) updateBanner.hidden = true;
  const newPath = `/annonce/${id}-${slugify(l.title)}`;
  if (window.location.pathname !== newPath) window.history.pushState({ type: 'listing', id }, '', newPath);
  const content = document.getElementById('listingModalContent');
  content.innerHTML = '';
  const natureLabel = l.subcategory_name ? `${l.category_icon} ${listingCategoryLabel(l)} · ${listingSubcategoryLabel(l)}` : `${l.category_icon} ${listingCategoryLabel(l)}`;
  const favBtn = el('button', {
    class: `detail-favorite-btn ${state.favoriteIds.has(l.id) ? 'is-active' : ''}`,
    id: 'detailFavoriteBtn',
    'data-listing-id': String(l.id),
    onclick: () => toggleFavorite(l.id, null),
  }, state.favoriteIds.has(l.id) ? i18n.t('favorites.remove') : i18n.t('favorites.add'));
  const isTourismListing = l.category_slug === 'tourisme-voyages';
  const headerNodes = [
    l.is_demo ? el('div', { class: 'demo-watermark demo-watermark--detail' }, i18n.t('demo.watermark')) : null,
    l.transaction_completed ? el('div', { class: 'transaction-stamp transaction-stamp--detail' }, l.listing_type === 'location' ? i18n.t('mine.stamp_rented') : i18n.t('mine.stamp_sold')) : null,
    renderDetailGallery(l.images, l.title),
    el('span', { class: 'detail-tag' }, `${natureLabel} · ${listingTypeLabel(l.listing_type)}`),
    el('h2', { id: 'detailTitleText' }, [l.title, l.owner_verified ? el('span', { class: 'verified-badge' }, `✓ ${i18n.t('detail.verified_seller')}`) : null]),
    el('div', { class: 'detail-price' }, priceLabel(l) + (l.listing_type === 'location' ? ' / mois' : '')),
    l.open_to_trade ? el('p', { class: 'trade-badge' }, `🔄 ${i18n.t('trade.open_badge')}${l.trade_description ? ' — ' + l.trade_description : ''}`) : null,
    l.date_start ? el('p', { class: 'tourism-dates-detail' }, `📅 ${formatListingDateRange(l)}`) : null,
    l.price_promo ? el('p', { class: 'tourism-promo-detail' }, [
      el('span', { class: 'tourism-promo-original' }, fmtPrice(l.price, l.currency)),
      ' ',
      el('span', { class: 'tourism-promo-price' }, fmtPrice(l.price_promo, l.currency)),
      l.price_type ? ` / ${priceTypeLabel(l.price_type)}` : '',
    ]) : (l.price_type ? el('p', { class: 'tourism-price-type-detail' }, priceTypeLabel(l.price_type)) : null),
    l.capacity_guests ? el('div', { class: 'tourism-lodging-facts' }, [
      el('span', {}, `🧑‍🤝‍🧑 ${l.capacity_guests}`),
      l.bedrooms ? el('span', {}, `🛏️ ${l.bedrooms}`) : null,
      l.bathrooms ? el('span', {}, `🚿 ${l.bathrooms}`) : null,
    ].filter(Boolean)) : null,
    l.amenities_json ? el('div', { class: 'tourism-amenities' },
      JSON.parse(l.amenities_json).map((a) => el('span', { class: 'tourism-amenity-chip' }, amenityLabel(a)))
    ) : null,
  ].filter(Boolean);
  content.append(
    ...(isTourismListing
      ? [el('div', { class: 'passport-header' }, [
          el('span', { class: 'passport-stamp' }, ['👁', el('br'), String(l.view_count)]),
          ...headerNodes,
        ])]
      : headerNodes),
    ...[
      el('p', { id: 'detailUpdateBanner', class: 'detail-update-banner', hidden: true }, [
        `🔄 ${i18n.t('detail.update_available')} `,
        el('button', { class: 'link-button', style: 'display:inline;margin:0;', onclick: () => openListingDetail(l.id) }, i18n.t('detail.update_refresh')),
      ]),
      el('p', { id: 'detailDescriptionText' }, l.description || i18n.t('detail.no_description')),
      l.owner_is_professional ? el('div', { class: 'detail-pro-block' }, [
        l.owner_company_logo_url ? el('img', { class: 'company-logo-detail', src: l.owner_company_logo_url, alt: l.owner_company_name || '' }) : null,
        el('div', {}, [
          el('div', { style: 'font-weight:700;' }, l.owner_company_name || l.owner_name),
          el('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:4px;' }, [
            proBadge(l.owner_pro_tier),
            l.owner_domain_verified ? el('span', { class: 'pro-domain-badge' }, `✓ ${i18n.t('pro.domain_verified')}`) : null,
          ]),
        ]),
      ]) : null,
      el('p', { class: 'detail-meta' }, [
        `${l.city_name}, ${listingCountryLabel(l)} · ${i18n.t('detail.posted_by')} ${l.owner_name}${l.city_timezone ? ' · ' + (formatLocalTime(l.city_timezone) ? i18n.t('detail.local_time') + ' : ' + formatLocalTime(l.city_timezone) : '') : ''}`,
        l.owner_review_count > 0 ? el('span', { class: 'seller-rating' }, `★ ${l.owner_avg_rating} (${l.owner_review_count})`) : null,
      ]),
      el('p', { class: 'view-count' }, `👁 ${i18n.t('detail.view_count', { count: l.view_count })}`),
      el('p', { class: 'view-count' }, `${i18n.t('mine.published_on', { date: new Date(l.created_at + 'Z').toLocaleDateString() })} · ${listingExpiryInfo(l).expired ? i18n.t('expiry.expired') : i18n.t('mine.days_left', { days: listingExpiryInfo(l).daysLeft })}`),
      favBtn,
      el('button', { class: 'share-postcard-btn', onclick: () => shareListingAsPostcard(l) }, `📮 ${i18n.t('share.postcard_button')}`),
      (state.user && state.user.id !== l.user_id && l.owner_phone)
        ? el('a', {
            class: 'whatsapp-btn',
            href: `https://wa.me/${l.owner_phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(i18n.t('whatsapp.prefill_message', { title: l.title }))}`,
            target: '_blank', rel: 'noopener',
          }, `💬 ${i18n.t('whatsapp.contact_button')}`)
        : null,
    ].filter((node) => node != null)
  );
  trackRecentlyViewed(l);
  renderRecentlyViewed();
  autoTranslateListingIfNeeded(l);
  const similarBox = el('div', { class: 'similar-listings', id: 'similarListingsBox' });
  content.append(similarBox);
  loadSimilarListings(l.id, similarBox);
  const onThePathBox = el('div', { class: 'on-the-path', id: 'onThePathBox' });
  content.append(onThePathBox);
  loadOnThePath(l.id, onThePathBox);
  if (state.user && state.aiSettings.has_key) {
    const translateBox = el('div', { class: 'ai-translate-box' });
    content.append(
      el('button', { class: 'ai-translate-link', onclick: () => translateListingInline(l, translateBox) }, i18n.t('ai.translate_button')),
      translateBox
    );
  }
  if (state.user && state.user.id === l.user_id) {
    content.append(
      el('div', { class: 'detail-actions' }, [
        el('button', { class: 'btn btn--danger', onclick: () => deleteListing(l.id) }, i18n.t('detail.delete_listing')),
      ])
    );
  } else if (state.user) {
    const textarea = el('textarea', { class: 'contact-textarea', rows: '3', 'data-i18n-placeholder': 'messages.write_placeholder', placeholder: i18n.t('messages.write_placeholder') });
    const errorEl = el('p', { class: 'form-error', hidden: 'true' });
    content.append(
      el('div', { class: 'contact-box' }, [
        el('h3', {}, i18n.t('messages.contact_seller')),
        el('p', { class: 'form-notice' }, termsNoticeNode('terms.message_reminder_prefix')),
        textarea,
        errorEl,
        el('button', {
          class: 'btn btn--primary',
          onclick: async () => {
            const body = textarea.value.trim();
            if (!body) return;
            errorEl.hidden = true;
            try {
              const res = await api('/conversations', { method: 'POST', body: JSON.stringify({ listing_id: l.id, body }) });
              showToast(i18n.t('toast.message_sent'));
              document.getElementById('listingModal').hidden = true;
              refreshUnreadCount();
              navigate('messages');
              openConversation(res.conversation_id);
            } catch (e) {
              errorEl.textContent = friendlyErrorMessage(e);
              errorEl.hidden = false;
            }
          },
        }, i18n.t('messages.send')),
      ])
    );
  } else {
    content.append(
      el('div', { class: 'detail-actions' }, [
        el('button', { class: 'btn btn--primary', onclick: () => openAuthModal('login') }, i18n.t('messages.login_to_contact')),
      ])
    );
  }
  if (state.user && state.user.id !== l.user_id) {
    content.append(el('button', { class: 'report-link', onclick: () => toggleReportBox(l.id) }, i18n.t('report.link')));
    content.append(el('div', { class: 'report-box', id: 'reportBox', hidden: 'true' }));
  }
  document.getElementById('listingModal').hidden = false;
}
/** Construit le contenu du formulaire de signalement (motif + détails) à
 * l'intérieur de la boîte fournie — factorisé pour être réutilisé aussi
 * bien depuis le détail d'une annonce que depuis une conversation. */
function renderReportBoxContent(box, listingId) {
  box.innerHTML = '';
  const select = el('select', {}, [
    el('option', { value: 'spam' }, i18n.t('report.reason_spam')),
    el('option', { value: 'hateful' }, i18n.t('report.reason_hateful')),
    el('option', { value: 'scam' }, i18n.t('report.reason_scam')),
    el('option', { value: 'other' }, i18n.t('report.reason_other')),
  ]);
  const textarea = el('textarea', { rows: '2', 'data-i18n-placeholder': 'report.details_placeholder', placeholder: i18n.t('report.details_placeholder') });
  const errorEl = el('p', { class: 'form-error', hidden: 'true' });
  box.append(
    select, textarea, errorEl,
    el('button', {
      class: 'btn btn--danger btn--small',
      onclick: async () => {
        errorEl.hidden = true;
        try {
          await api('/reports', { method: 'POST', body: JSON.stringify({ listing_id: listingId, reason: select.value, details: textarea.value.trim() }) });
          showToast(i18n.t('toast.report_sent'));
          box.hidden = true;
        } catch (e) {
          errorEl.textContent = e.message;
          errorEl.hidden = false;
        }
      },
    }, i18n.t('report.submit'))
  );
}
function toggleReportBox(listingId) {
  const box = document.getElementById('reportBox');
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  renderReportBoxContent(box, listingId);
}
async function deleteListing(id) {
  if (!confirm(i18n.t('detail.confirm_delete'))) return;
  try {
    await api(`/listings/${id}`, { method: 'DELETE' });
    document.getElementById('listingModal').hidden = true;
    showToast(i18n.t('toast.listing_deleted'));
    if (state.selectedCity) refreshListings();
    if (!document.getElementById('view-mine').hidden) loadMyListings();
  } catch (e) {
    showToast(e.message);
  }
}
// ---------- Publication ----------
function termsNoticeNode(prefixKey) {
  return el('span', {}, [
    i18n.t(prefixKey) + ' ',
    el('button', { type: 'button', onclick: () => navigate('terms') }, i18n.t('footer.terms_link')),
  ]);
}
let uploadedImageUrl = null;
function resetImageUpload() {
  uploadedImageUrl = null;
  document.getElementById('imagePreview').hidden = true;
  document.getElementById('imagePreviewImg').src = '';
  document.getElementById('publishImageFile').value = '';
  document.getElementById('uploadProgress').hidden = true;
}
document.getElementById('publishImageFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    showToast(i18n.t('upload.invalid_type'));
    e.target.value = '';
    return;
  }
  if (file.size > 5_000_000) {
    showToast(i18n.t('upload.too_large'));
    e.target.value = '';
    return;
  }
  const progress = document.getElementById('uploadProgress');
  progress.hidden = false;
  progress.textContent = i18n.t('upload.in_progress');
  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await api('/uploads', { method: 'POST', body: JSON.stringify({ data: base64, mime: file.type }) });
    uploadedImageUrl = res.url;
    document.getElementById('imagePreviewImg').src = res.url;
    document.getElementById('imagePreview').hidden = false;
    document.getElementById('publishImageUrl').value = '';
    document.getElementById('publishImageUrl').disabled = true;
    progress.hidden = true;
  } catch (err) {
    showToast(err.message);
    progress.hidden = true;
    e.target.value = '';
  }
});
document.getElementById('imagePreviewRemove').addEventListener('click', () => {
  resetImageUpload();
  document.getElementById('publishImageUrl').disabled = false;
});
document.getElementById('aiDraftGenerateBtn').addEventListener('click', async () => {
  const notes = document.getElementById('aiDraftNotes').value.trim();
  const errEl = document.getElementById('aiDraftError');
  errEl.hidden = true;
  if (!notes) { errEl.textContent = i18n.t('ai.draft_notes_required'); errEl.hidden = false; return; }
  const btn = document.getElementById('aiDraftGenerateBtn');
  const originalText = btn.textContent;
  btn.textContent = i18n.t('ai.draft_generating');
  btn.disabled = true;
  try {
    const result = await api('/ai/draft-listing', {
      method: 'POST',
      body: JSON.stringify({
        category_id: document.getElementById('publishCategory').value,
        subcategory_id: document.getElementById('publishSubcategory').value,
        listing_type: document.getElementById('publishListingType').value,
        notes,
      }),
    });
    document.querySelector('#publishForm input[name=title]').value = result.title;
    document.querySelector('#publishForm textarea[name=description]').value = result.description;
    showToast(i18n.t('toast.ai_draft_ready'));
  } catch (err) {
    errEl.textContent = friendlyErrorMessage(err);
    errEl.hidden = false;
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
});
// Même dictionnaire que server.js — copie volontaire côté client pour un
// avertissement instantané, sans aller-retour réseau. Français uniquement
// pour l'instant (voir la même limite côté serveur).
// comparaison ignore les accents (voir normalizeForMatch), donc chaque
// mot-clé n'a besoin d'être écrit qu'une seule fois, avec ses accents.
const CATEGORY_KEYWORDS_FR = {
  immobilier: ['appartement', 'studio', 'duplex', 'villa', 'chambre à louer', 'mètres carrés', 'loyer', 'copropriété', 'terrain constructible', 'lotissement', 'maison', 'immeuble', 'local commercial', 'bureau à louer', 'riad', 'triplex', 'penthouse', 'charges comprises', 'cuisine équipée', 'terrasse', 'balcon', 'garage inclus', 'parking privé', 'résidence sécurisée', 'promoteur immobilier', 'plain-pied'],
  vehicules: ['voiture', 'véhicule', 'kilométrage', 'boîte automatique', 'carte grise', 'chevaux fiscaux', 'moto', 'scooter', '4x4', 'camion', 'essence', 'diesel', 'berline', 'citadine', 'suv', 'break', 'pneus', 'boîte manuelle', 'première main', 'contrôle technique', 'assurance auto', 'remorque', 'quad', 'utilitaire', 'automobile', 'motocyclette'],
  mode: ['robe', 'chaussures', 'sac à main', 'maroquinerie', 'bijoux', 'montre', 'vêtement', 'pointure', 'sneakers', 'baskets', 'costume', 'manteau', 'veste', 'jean', 'foulard', 'ceinture', 'parfum', 'accessoire mode', 'collection mode', 'tenue'],
  'maison-jardin': ['canapé', 'réfrigérateur', 'machine à laver', 'tondeuse', 'électroménager', 'meuble', 'jardin', 'table à manger', 'lit double', 'matelas', 'four', 'micro-ondes', 'climatiseur', 'décoration intérieure', 'rideaux', 'tapis', 'vaisselle', 'plantes', 'literie'],
  multimedia: ['iphone', 'smartphone', 'ordinateur portable', 'playstation', 'xbox', 'tablette', 'appareil photo', 'écran', 'samsung galaxy', 'macbook', 'clavier', 'souris', 'imprimante', 'disque dur', 'processeur', 'carte graphique', 'casque audio', 'enceinte bluetooth', 'ordinateur de bureau'],
  famille: ['poussette', 'biberon', 'berceau', 'siège auto enfant', 'jouet', 'vêtement bébé', 'lit bébé', 'chaise haute', 'couches', 'peluche', 'landau', 'baby-sitting'],
  loisirs: ['guitare', 'piano', 'vélo', 'tente de camping', 'canne à pêche', 'instrument de musique', 'ballon', 'raquette', 'skateboard', 'trottinette', 'batterie musicale', 'équipement de sport', 'randonnée'],
  'materiel-pro': ['machine industrielle', 'échafaudage', 'tracteur', 'mobilier de bureau', 'matériel professionnel', 'groupe électrogène', 'compresseur', 'chariot élévateur', 'matériel btp', 'équipement médical'],
  services: ['prestation', 'cours particuliers', 'dépannage', 'déménagement', 'nettoyage à domicile', 'garde d\'enfants', 'traiteur', 'photographe professionnel', 'coach sportif'],
  emploi: ['recrute', 'cdi', 'cdd', 'salaire mensuel', 'poste à pourvoir', 'expérience requise', 'candidature', 'entretien d\'embauche', 'offre d\'emploi', 'stage rémunéré', 'télétravail'],
  'opportunites-affaires': ['investisseur', 'franchise', 'partenaire commercial', "appel d'offres", "cession d'entreprise", 'business plan', 'levée de fonds', 'associé recherché'],
};
/** Même détection que CATEGORY_KEYWORDS_FR, en anglais — un titre peut
 * être rédigé dans n'importe quelle langue quelle que soit la langue de
 * l'interface, les deux dictionnaires sont donc toujours combinés. */
const CATEGORY_KEYWORDS_EN = {
  immobilier: ['apartment', 'studio', 'duplex', 'villa', 'room for rent', 'square meters', 'square feet', 'rent', 'condo', 'condominium', 'buildable land', 'subdivision', 'house', 'building', 'commercial space', 'office for rent', 'penthouse', 'triplex', 'utilities included', 'equipped kitchen', 'terrace', 'balcony', 'garage included', 'private parking', 'gated community', 'real estate developer', 'single-story'],
  vehicules: ['car', 'vehicle', 'mileage', 'automatic transmission', 'title', 'registration', 'horsepower', 'motorcycle', 'scooter', 'suv', 'truck', 'gasoline', 'diesel', 'sedan', 'hatchback', 'station wagon', 'tires', 'manual transmission', 'first owner', 'inspection', 'car insurance', 'trailer', 'quad bike', 'van', 'automobile', 'motorbike'],
  mode: ['dress', 'shoes', 'handbag', 'leather goods', 'jewelry', 'watch', 'clothing', 'shoe size', 'sneakers', 'suit', 'coat', 'jacket', 'jeans', 'scarf', 'belt', 'perfume', 'fashion accessory', 'fashion collection', 'outfit'],
  'maison-jardin': ['sofa', 'refrigerator', 'washing machine', 'lawn mower', 'appliance', 'furniture', 'garden', 'dining table', 'double bed', 'mattress', 'oven', 'microwave', 'air conditioner', 'interior decoration', 'curtains', 'rug', 'dishware', 'plants', 'bedding'],
  multimedia: ['iphone', 'smartphone', 'laptop', 'playstation', 'xbox', 'tablet', 'camera', 'screen', 'samsung galaxy', 'macbook', 'keyboard', 'mouse', 'printer', 'hard drive', 'processor', 'graphics card', 'headphones', 'bluetooth speaker', 'desktop computer'],
  famille: ['stroller', 'baby bottle', 'crib', 'car seat', 'toy', 'baby clothes', 'baby bed', 'high chair', 'diapers', 'stuffed animal', 'pram', 'babysitting'],
  loisirs: ['guitar', 'piano', 'bicycle', 'camping tent', 'fishing rod', 'musical instrument', 'racket', 'skateboard', 'kick scooter', 'drum kit', 'sports equipment', 'hiking'],
  'materiel-pro': ['industrial machine', 'scaffolding', 'tractor', 'office furniture', 'professional equipment', 'generator', 'compressor', 'forklift', 'construction equipment', 'medical equipment'],
  services: ['service', 'private lessons', 'repair', 'moving service', 'home cleaning', 'childcare', 'catering', 'professional photographer', 'sports coach'],
  emploi: ['hiring', 'full-time position', 'contract', 'monthly salary', 'position available', 'experience required', 'application', 'job interview', 'job offer', 'paid internship', 'remote work'],
  'opportunites-affaires': ['investor', 'franchise', 'business partner', 'tender', 'business for sale', 'business plan', 'fundraising', 'partner wanted'],
};
const CATEGORY_KEYWORDS_IT = {
  immobilier: ['appartamento', 'monolocale', 'duplex', 'villa', 'camera in affitto', 'metri quadrati', 'affitto', 'condominio', 'terreno edificabile', 'lottizzazione', 'casa', 'edificio', 'locale commerciale', 'ufficio in affitto', 'attico', 'trilocale', 'spese condominiali incluse', 'cucina attrezzata', 'terrazza', 'balcone', 'garage incluso', 'parcheggio privato', 'residence sicuro', 'promotore immobiliare', 'piano terra'],
  vehicules: ['auto', 'veicolo', 'chilometraggio', 'cambio automatico', 'libretto di circolazione', 'cavalli fiscali', 'moto', 'scooter', 'fuoristrada', 'camion', 'benzina', 'diesel', 'berlina', 'citycar', 'station wagon', 'pneumatici', 'cambio manuale', 'primo proprietario', 'revisione', 'assicurazione auto', 'rimorchio', 'quad', 'furgone', 'automobile', 'motocicletta'],
  mode: ['abito', 'scarpe', 'borsa', 'pelletteria', 'gioielli', 'orologio', 'abbigliamento', 'numero di scarpe', 'sneakers', 'vestito', 'cappotto', 'giacca', 'jeans', 'sciarpa', 'cintura', 'profumo', 'accessorio moda', 'collezione moda', 'tenuta'],
  'maison-jardin': ['divano', 'frigorifero', 'lavatrice', 'tosaerba', 'elettrodomestico', 'mobile', 'giardino', 'tavolo da pranzo', 'letto matrimoniale', 'materasso', 'forno', 'microonde', 'climatizzatore', "decorazione d'interni", 'tende', 'tappeto', 'stoviglie', 'piante', 'biancheria da letto'],
  multimedia: ['iphone', 'smartphone', 'computer portatile', 'playstation', 'xbox', 'tablet', 'fotocamera', 'schermo', 'samsung galaxy', 'macbook', 'tastiera', 'mouse', 'stampante', 'disco rigido', 'processore', 'scheda grafica', 'cuffie', 'cassa bluetooth', 'computer fisso'],
  famille: ['passeggino', 'biberon', 'culla', 'seggiolino auto', 'giocattolo', 'vestiti per bambini', 'lettino', 'seggiolone', 'pannolini', 'peluche', 'carrozzina', 'babysitting'],
  loisirs: ['chitarra', 'pianoforte', 'bicicletta', 'tenda da campeggio', 'canna da pesca', 'strumento musicale', 'racchetta', 'skateboard', 'monopattino', 'batteria musicale', 'attrezzatura sportiva', 'escursionismo'],
  'materiel-pro': ['macchina industriale', 'ponteggio', 'trattore', 'mobili per ufficio', 'attrezzatura professionale', 'generatore', 'compressore', 'carrello elevatore', 'attrezzatura edile', 'attrezzatura medica'],
  services: ['servizio', 'lezioni private', 'riparazione', 'trasloco', 'pulizia domestica', 'assistenza bambini', 'catering', 'fotografo professionista', 'personal trainer'],
  emploi: ['assumiamo', 'tempo indeterminato', 'tempo determinato', 'stipendio mensile', 'posizione disponibile', 'esperienza richiesta', 'candidatura', 'colloquio di lavoro', 'offerta di lavoro', 'stage retribuito', 'lavoro da remoto'],
  'opportunites-affaires': ['investitore', 'franchising', 'socio commerciale', "gara d'appalto", "cessione d'azienda", 'business plan', 'raccolta fondi', 'cercasi socio'],
};
const CATEGORY_KEYWORDS_AR = {
  immobilier: ['شقة', 'استوديو', 'دوبلكس', 'فيلا', 'غرفة للإيجار', 'متر مربع', 'إيجار', 'ملكية مشتركة', 'أرض قابلة للبناء', 'تجزئة سكنية', 'منزل', 'عمارة', 'محل تجاري', 'مكتب للإيجار', 'بنتهاوس', 'تريبلكس', 'شامل الخدمات', 'مطبخ مجهز', 'تراس', 'شرفة', 'كراج مشمول', 'موقف خاص', 'إقامة آمنة', 'مطور عقاري', 'طابق أرضي'],
  vehicules: ['سيارة', 'مركبة', 'كيلومترات مقطوعة', 'ناقل حركة أوتوماتيكي', 'بطاقة رمادية', 'قوة جبائية', 'دراجة نارية', 'سكوتر', 'دفع رباعي', 'شاحنة', 'بنزين', 'ديزل', 'سيدان', 'سيتي كار', 'ستيشن واغن', 'إطارات', 'ناقل حركة يدوي', 'يد أولى', 'فحص تقني', 'تأمين سيارات', 'مقطورة', 'كوادر', 'فان', 'دراجة نارية'],
  mode: ['فستان', 'أحذية', 'حقيبة يد', 'سلع جلدية', 'مجوهرات', 'ساعة', 'ملابس', 'مقاس الحذاء', 'أحذية رياضية', 'بدلة', 'معطف', 'سترة', 'جينز', 'وشاح', 'حزام', 'عطر', 'إكسسوار موضة', 'مجموعة أزياء', 'إطلالة'],
  'maison-jardin': ['أريكة', 'ثلاجة', 'غسالة', 'جزازة عشب', 'أجهزة منزلية', 'أثاث', 'حديقة', 'طاولة طعام', 'سرير مزدوج', 'مرتبة', 'فرن', 'ميكروويف', 'مكيف هواء', 'ديكور داخلي', 'ستائر', 'سجادة', 'أواني', 'نباتات', 'مفروشات سرير'],
  multimedia: ['آيفون', 'هاتف ذكي', 'حاسوب محمول', 'بلايستيشن', 'إكس بوكس', 'لوحي', 'كاميرا', 'شاشة', 'سامسونج جالاكسي', 'ماك بوك', 'لوحة مفاتيح', 'فأرة', 'طابعة', 'قرص صلب', 'معالج', 'بطاقة رسومات', 'سماعات', 'مكبر بلوتوث', 'حاسوب مكتبي'],
  famille: ['عربة أطفال', 'رضاعة', 'سرير أطفال', 'مقعد سيارة للأطفال', 'لعبة', 'ملابس أطفال', 'سرير رضيع', 'كرسي مرتفع', 'حفاضات', 'دمية محشوة', 'رعاية أطفال'],
  loisirs: ['غيتار', 'بيانو', 'دراجة هوائية', 'خيمة تخييم', 'صنارة صيد', 'آلة موسيقية', 'مضرب', 'سكيت بورد', 'طبول موسيقية', 'معدات رياضية', 'رحلات المشي'],
  'materiel-pro': ['آلة صناعية', 'سقالة', 'جرار', 'أثاث مكتبي', 'معدات مهنية', 'مولد كهربائي', 'ضاغط هواء', 'رافعة شوكية', 'معدات بناء', 'معدات طبية'],
  services: ['خدمة', 'دروس خصوصية', 'إصلاح', 'نقل أثاث', 'تنظيف منزلي', 'رعاية أطفال', 'تموين', 'مصور محترف', 'مدرب رياضي'],
  emploi: ['توظيف', 'عقد دائم', 'عقد محدد المدة', 'راتب شهري', 'منصب شاغر', 'خبرة مطلوبة', 'طلب توظيف', 'مقابلة عمل', 'عرض عمل', 'تدريب مدفوع', 'عمل عن بعد'],
  'opportunites-affaires': ['مستثمر', 'امتياز تجاري', 'شريك تجاري', 'طلب عروض', 'بيع شركة', 'خطة عمل', 'جمع تمويل', 'مطلوب شريك'],
};
const CATEGORY_KEYWORDS_ES = {
  immobilier: ['apartamento', 'estudio', 'dúplex', 'villa', 'habitación en alquiler', 'metros cuadrados', 'alquiler', 'condominio', 'terreno edificable', 'urbanización', 'casa', 'edificio', 'local comercial', 'oficina en alquiler', 'ático', 'triplex', 'gastos incluidos', 'cocina equipada', 'terraza', 'balcón', 'garaje incluido', 'aparcamiento privado', 'residencia segura', 'promotor inmobiliario', 'planta baja'],
  vehicules: ['coche', 'vehículo', 'kilometraje', 'cambio automático', 'permiso de circulación', 'caballos fiscales', 'moto', 'scooter', 'todoterreno', 'camión', 'gasolina', 'diésel', 'sedán', 'utilitario', 'familiar', 'neumáticos', 'cambio manual', 'primera mano', 'inspección técnica', 'seguro de coche', 'remolque', 'quad', 'furgoneta', 'automóvil', 'motocicleta'],
  mode: ['vestido', 'zapatos', 'bolso', 'marroquinería', 'joyas', 'reloj', 'ropa', 'talla de zapato', 'zapatillas', 'traje', 'abrigo', 'chaqueta', 'vaqueros', 'bufanda', 'cinturón', 'perfume', 'accesorio de moda', 'colección de moda', 'conjunto'],
  'maison-jardin': ['sofá', 'frigorífico', 'lavadora', 'cortacésped', 'electrodoméstico', 'mueble', 'jardín', 'mesa de comedor', 'cama doble', 'colchón', 'horno', 'microondas', 'aire acondicionado', 'decoración interior', 'cortinas', 'alfombra', 'vajilla', 'plantas', 'ropa de cama'],
  multimedia: ['iphone', 'smartphone', 'portátil', 'playstation', 'xbox', 'tableta', 'cámara', 'pantalla', 'samsung galaxy', 'macbook', 'teclado', 'ratón', 'impresora', 'disco duro', 'procesador', 'tarjeta gráfica', 'auriculares', 'altavoz bluetooth', 'ordenador de sobremesa'],
  famille: ['cochecito', 'biberón', 'cuna', 'silla de coche para niños', 'juguete', 'ropa de bebé', 'cama de bebé', 'trona', 'pañales', 'peluche', 'cuidado de niños'],
  loisirs: ['guitarra', 'piano', 'bicicleta', 'tienda de campaña', 'caña de pescar', 'instrumento musical', 'raqueta', 'monopatín', 'patinete', 'batería musical', 'equipo deportivo', 'senderismo'],
  'materiel-pro': ['máquina industrial', 'andamio', 'tractor', 'mobiliario de oficina', 'equipo profesional', 'generador', 'compresor', 'carretilla elevadora', 'equipo de construcción', 'equipo médico'],
  services: ['servicio', 'clases particulares', 'reparación', 'mudanza', 'limpieza del hogar', 'cuidado de niños', 'catering', 'fotógrafo profesional', 'entrenador deportivo'],
  emploi: ['contratamos', 'contrato indefinido', 'contrato temporal', 'salario mensual', 'puesto disponible', 'experiencia requerida', 'candidatura', 'entrevista de trabajo', 'oferta de empleo', 'prácticas remuneradas', 'trabajo remoto'],
  'opportunites-affaires': ['inversor', 'franquicia', 'socio comercial', 'licitación', 'venta de empresa', 'plan de negocio', 'captación de fondos', 'se busca socio'],
};
const CATEGORY_KEYWORDS_PT = {
  immobilier: ['apartamento', 'estúdio', 'duplex', 'moradia', 'quarto para alugar', 'metros quadrados', 'arrendamento', 'condomínio', 'terreno urbanizável', 'loteamento', 'casa', 'edifício', 'espaço comercial', 'escritório para alugar', 'cobertura', 'triplex', 'despesas incluídas', 'cozinha equipada', 'terraço', 'varanda', 'garagem incluída', 'estacionamento privado', 'condomínio fechado', 'promotor imobiliário', 'rés-do-chão'],
  vehicules: ['carro', 'veículo', 'quilometragem', 'câmbio automático', 'documento do veículo', 'cavalos fiscais', 'moto', 'scooter', 'suv', 'caminhão', 'gasolina', 'diesel', 'sedã', 'citadino', 'perua', 'pneus', 'câmbio manual', 'primeiro dono', 'inspeção veicular', 'seguro automóvel', 'reboque', 'quadriciclo', 'van', 'automóvel', 'motocicleta'],
  mode: ['vestido', 'sapatos', 'bolsa', 'marroquinaria', 'joias', 'relógio', 'roupa', 'numeração de sapato', 'tênis', 'terno', 'casaco', 'jaqueta', 'jeans', 'lenço', 'cinto', 'perfume', 'acessório de moda', 'coleção de moda', 'look'],
  'maison-jardin': ['sofá', 'geladeira', 'máquina de lavar', 'cortador de grama', 'eletrodoméstico', 'móvel', 'jardim', 'mesa de jantar', 'cama de casal', 'colchão', 'forno', 'micro-ondas', 'ar-condicionado', 'decoração de interiores', 'cortinas', 'tapete', 'louças', 'plantas', 'roupa de cama'],
  multimedia: ['iphone', 'smartphone', 'notebook', 'playstation', 'xbox', 'tablet', 'câmera', 'tela', 'samsung galaxy', 'macbook', 'teclado', 'mouse', 'impressora', 'disco rígido', 'processador', 'placa de vídeo', 'fones de ouvido', 'caixa de som bluetooth', 'computador de mesa'],
  famille: ['carrinho de bebê', 'mamadeira', 'berço', 'cadeirinha para carro', 'brinquedo', 'roupa de bebê', 'cama de bebê', 'cadeira alta', 'fraldas', 'pelúcia', 'cuidado infantil'],
  loisirs: ['violão', 'piano', 'bicicleta', 'barraca de camping', 'vara de pesca', 'instrumento musical', 'raquete', 'skate', 'patinete', 'bateria musical', 'equipamento esportivo', 'trilha'],
  'materiel-pro': ['máquina industrial', 'andaime', 'trator', 'mobiliário de escritório', 'equipamento profissional', 'gerador', 'compressor', 'empilhadeira', 'equipamento de construção', 'equipamento médico'],
  services: ['serviço', 'aulas particulares', 'reparo', 'mudança', 'limpeza doméstica', 'cuidado infantil', 'buffet', 'fotógrafo profissional', 'personal trainer'],
  emploi: ['contratamos', 'contrato efetivo', 'contrato temporário', 'salário mensal', 'vaga disponível', 'experiência necessária', 'candidatura', 'entrevista de emprego', 'oferta de emprego', 'estágio remunerado', 'trabalho remoto'],
  'opportunites-affaires': ['investidor', 'franquia', 'sócio comercial', 'licitação', 'venda de empresa', 'plano de negócios', 'captação de recursos', 'procura-se sócio'],
};
const CATEGORY_KEYWORDS_ALL = Object.fromEntries(
  Object.keys(CATEGORY_KEYWORDS_FR).map((slug) => [slug, [
    ...(CATEGORY_KEYWORDS_FR[slug] || []),
    ...(CATEGORY_KEYWORDS_EN[slug] || []),
    ...(CATEGORY_KEYWORDS_IT[slug] || []),
    ...(CATEGORY_KEYWORDS_AR[slug] || []),
    ...(CATEGORY_KEYWORDS_ES[slug] || []),
    ...(CATEGORY_KEYWORDS_PT[slug] || []),
  ]])
);
/** Retire les accents pour une comparaison insensible aux accents (é/e,
 * è/e, â/a, etc.) — un titre tapé sans accents (fréquent sur mobile ou
 * clavier étranger) doit être reconnu tout aussi bien qu'avec accents. */
function normalizeForMatch(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function detectCategoryMismatchClient(title, description, categorySlug) {
  const text = normalizeForMatch(`${title} ${description || ''}`);
  let bestMatch = null;
  let bestCount = 0;
  for (const [slug, keywords] of Object.entries(CATEGORY_KEYWORDS_ALL)) {
    if (slug === categorySlug) continue;
    const count = keywords.filter((kw) => text.includes(normalizeForMatch(kw))).length;
    if (count > bestCount) { bestCount = count; bestMatch = slug; }
  }
  const ownCount = (CATEGORY_KEYWORDS_ALL[categorySlug] || []).filter((kw) => text.includes(normalizeForMatch(kw))).length;
  if (bestMatch && bestCount >= 1 && ownCount === 0) return bestMatch;
  return null;
}
/** Relit le titre/la description/la catégorie actuellement saisis et
 * affiche (ou masque) un avertissement discret — jamais bloquant, juste
 * une invitation à vérifier avant de publier. */
function updateCategoryMismatchWarning() {
  const warningEl = document.getElementById('categoryMismatchWarning');
  if (!warningEl) return;
  const titleInput = document.querySelector('#publishForm input[name=title]');
  const descInput = document.querySelector('#publishForm textarea[name=description]');
  const cat = findCategoryById(document.getElementById('publishCategory').value);
  if (!titleInput || !cat) { warningEl.hidden = true; return; }
  const mismatchSlug = detectCategoryMismatchClient(titleInput.value, descInput ? descInput.value : '', cat.slug);
  if (!mismatchSlug) { warningEl.hidden = true; return; }
  const mismatchCategory = findCategoryBySlug(mismatchSlug);
  warningEl.textContent = `🤔 ${i18n.t('publish.category_mismatch_warning', { category: mismatchCategory ? categoryLabel(mismatchCategory) : mismatchSlug })}`;
  warningEl.hidden = false;
}
function preparePublishForm() {
  document.getElementById('publishError').hidden = true;
  document.getElementById('publishForm').reset();
  resetImageUpload();
  document.getElementById('publishImageUrl').disabled = false;
  document.getElementById('aiDraftBox').hidden = !state.aiSettings.has_key;
  document.getElementById('tradeDescriptionRow').hidden = true;
  document.getElementById('aiDraftNotes').value = '';
  document.getElementById('aiDraftError').hidden = true;
  const notice = document.getElementById('publishTermsNotice');
  notice.innerHTML = '';
  notice.append(termsNoticeNode('terms.publish_reminder_prefix'));
  const countrySelect = document.getElementById('publishCountry');
  if (state.countries[0]) handlePublishCountryChange(countrySelect.value || state.countries[0].id);
  const cat = findCategoryById(document.getElementById('publishCategory').value);
  fillSubcategorySelect(document.getElementById('publishSubcategory'), cat, false);
  updateTourismLodgingVisibility(findSubcategoryById(document.getElementById('publishSubcategory').value)?.slug);
  updatePublishTypeAndPriceUI(cat);
  updateSecondhandVisibility(cat ? cat.slug : null, 'secondhandCheckbox');
  updateTourismDatesVisibility(cat ? cat.slug : null);
  updateTourismPriceExtrasVisibility(cat ? cat.slug : null);
  const warningEl = document.getElementById('categoryMismatchWarning');
  if (warningEl) warningEl.hidden = true;
}
document.getElementById('openToTradeCheckbox').addEventListener('change', (e) => {
  document.getElementById('tradeDescriptionRow').hidden = !e.target.checked;
});
document.querySelector('#publishForm input[name=title]').addEventListener('input', debounce(updateCategoryMismatchWarning, 500));
document.querySelector('#publishForm textarea[name=description]').addEventListener('input', debounce(updateCategoryMismatchWarning, 500));
document.getElementById('publishCategory').addEventListener('change', updateCategoryMismatchWarning);
document.getElementById('publishSubcategory').addEventListener('change', (e) => {
  updateTourismLodgingVisibility(findSubcategoryById(e.target.value)?.slug);
});
document.getElementById('publishForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const payload = {
    title: fd.get('title'),
    category_id: Number(fd.get('category_id')),
    subcategory_id: Number(fd.get('subcategory_id')),
    listing_type: fd.get('listing_type'),
    city_id: Number(fd.get('city_id')),
    price: fd.get('price') === '' ? null : Number(fd.get('price')),
    currency: (fd.get('currency') || 'EUR').toUpperCase(),
    description: fd.get('description'),
    images: uploadedImageUrl ? [uploadedImageUrl] : (fd.get('image') ? [fd.get('image')] : []),
    open_to_trade: fd.get('open_to_trade') === 'on',
    trade_description: fd.get('trade_description'),
    is_secondhand: fd.get('is_secondhand') === 'on',
    date_start: fd.get('date_start') || null,
    date_end: fd.get('date_end') || null,
    price_promo: fd.get('price_promo') || null,
    price_type: fd.get('price_type') || null,
    capacity_guests: fd.get('capacity_guests') || null,
    bedrooms: fd.get('bedrooms') || null,
    bathrooms: fd.get('bathrooms') || null,
    amenities: fd.getAll('amenities'),
    language: i18n.effectiveLang(),
  };
  const errEl = document.getElementById('publishError');
  errEl.hidden = true;
  try {
    const result = await api('/listings', { method: 'POST', body: JSON.stringify(payload) });
    showToast(i18n.t('toast.listing_published'));
    if (result.tier_up) {
      setTimeout(() => showToast(i18n.t('pro.tier_up_toast', { tier: i18n.t(`pro.tier_${result.tier_up}`) })), 3800);
    }
    form.reset();
    resetImageUpload();
    document.getElementById('publishImageUrl').disabled = false;
    navigate('mine');
  } catch (err) {
    errEl.textContent = friendlyErrorMessage(err);
    errEl.hidden = false;
  }
});
// ---------- Mes annonces ----------
let pendingEventCountry = null;
function openEventModal(country) {
  if (!state.user) { openAuthModal('login'); return; }
  pendingEventCountry = country;
  document.getElementById('eventForm').reset();
  document.getElementById('eventFormError').hidden = true;
  document.getElementById('eventModal').hidden = false;
}
document.getElementById('eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('eventFormError');
  errEl.hidden = true;
  try {
    await api('/events', {
      method: 'POST',
      body: JSON.stringify({
        country_id: pendingEventCountry.id,
        title: fd.get('title'),
        event_date: fd.get('event_date'),
        end_date: fd.get('end_date') || null,
        location_name: fd.get('location_name'),
        description: fd.get('description'),
        external_link: fd.get('external_link'),
      }),
    });
    document.getElementById('eventModal').hidden = true;
    showToast(i18n.t('toast.event_published'));
    if (!document.getElementById('countryModal').hidden) loadBusinessOpportunities(pendingEventCountry);
  } catch (err) {
    errEl.textContent = friendlyErrorMessage(err);
    errEl.hidden = false;
  }
});
let pendingBoostListingId = null;
function openBoostModal(listing) {
  pendingBoostListingId = listing.id;
  document.getElementById('boostModal').hidden = false;
}
document.getElementById('confirmBoostBtn').addEventListener('click', async () => {
  try {
    await api(`/listings/${pendingBoostListingId}/boost`, { method: 'POST' });
    showToast(i18n.t('toast.boost_activated'));
    document.getElementById('boostModal').hidden = true;
    loadMyListings();
  } catch (e) {
    showToast(friendlyErrorMessage(e));
  }
});
async function loadMyListings() {
  const listings = await api('/me/listings');
  state.lists.mine = listings;
  renderMyListings(listings);
  loadSellerStats();
}
async function loadSellerStats() {
  const box = document.getElementById('sellerStats');
  try {
    const s = await api('/me/stats');
    box.innerHTML = '';
    const stat = (label, value) => el('div', { class: 'seller-stat' }, [el('span', { class: 'seller-stat-value' }, String(value)), el('span', { class: 'seller-stat-label' }, label)]);
    box.append(
      stat(i18n.t('stats.active_listings'), s.active_listings || 0),
      stat(i18n.t('stats.total_views'), s.total_views || 0),
      stat(i18n.t('stats.total_favorites'), s.total_favorites_received || 0),
      stat(i18n.t('stats.avg_rating'), s.avg_rating ? `★ ${s.avg_rating}` : '—'),
    );
  } catch { box.innerHTML = ''; }
  const reminder = document.getElementById('referralReminder');
  reminder.innerHTML = '';
  reminder.hidden = false;
  const credits = state.user?.free_boost_credits || 0;
  reminder.append(
    el('button', { class: 'referral-reminder-link', onclick: () => navigate('passport') },
      credits > 0 ? `🎁 ${i18n.t('referral.reminder_has_credits', { count: credits })}` : `🎁 ${i18n.t('referral.reminder_no_credits')}`
    )
  );
}
function listingExpiryInfo(l) {
  const expiresAt = new Date(l.expires_at + 'Z');
  const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
  return { expired: daysLeft <= 0, soon: daysLeft > 0 && daysLeft <= 7, daysLeft };
}
function renderMyListings(listings) {
  const grid = document.getElementById('myListingGrid');
  grid.innerHTML = '';
  if (!listings || listings.length === 0) {
    grid.append(el('div', { class: 'empty-state' }, [
      i18n.t('mine.empty') + ' ',
      el('button', { class: 'btn btn--primary btn--small', onclick: () => navigate('publish') }, i18n.t('mine.publish_now')),
    ]));
    return;
  }
  for (const l of listings) {
    const expiry = listingExpiryInfo(l);
    const isBoosted = l.boosted_until && new Date(l.boosted_until + 'Z') > new Date();
    grid.append(
      el('article', { class: 'card', onclick: () => openListingDetail(l.id) }, [
        (l.images && l.images[0]) ? el('img', { class: 'card-img', src: l.images[0], alt: l.title }) : el('div', { class: 'card-img' }),
        isBoosted ? el('span', { class: 'boost-badge' }, `🚀 ${i18n.t('boost.active_badge')}`) : null,
        el('div', { class: 'card-body' }, [
          el('span', { class: 'card-tag' }, `${l.subcategory_name ? listingSubcategoryLabel(l) : listingCategoryLabel(l)} · ${listingTypeLabel(l.listing_type)} · ${l.status}`),
          el('h3', { class: 'card-title' }, l.title),
          el('span', { class: 'card-place' }, `${l.city_name}, ${listingCountryLabel(l)}`),
          el('span', { class: 'card-price' }, priceLabel(l)),
          el('span', { class: 'card-mini-stats' }, `👁 ${l.view_count}   ·   ♥ ${l.favorite_count}`),
          el('span', { class: 'card-mini-stats' }, `${i18n.t('mine.published_on', { date: new Date(l.created_at + 'Z').toLocaleDateString() })} · ${expiry.expired ? i18n.t('expiry.expired') : i18n.t('mine.days_left', { days: expiry.daysLeft })}`),
          expiry.soon && !expiry.expired ? el('p', { class: 'expiry-warning' }, i18n.t('expiry.soon', { days: expiry.daysLeft })) : null,
          el('div', { class: 'detail-actions' }, [
            el('button', { class: 'btn btn--ghost btn--small', onclick: (e) => { e.stopPropagation(); openListingDetail(l.id); } }, i18n.t('mine.view')),
            (expiry.expired || expiry.soon)
              ? el('button', { class: 'btn btn--ghost btn--small', onclick: async (e) => { e.stopPropagation(); await api(`/listings/${l.id}/renew`, { method: 'POST' }); showToast(i18n.t('toast.listing_renewed')); loadMyListings(); } }, i18n.t('expiry.renew'))
              : null,
            !isBoosted ? el('button', { class: 'btn btn--ghost btn--small', onclick: (e) => { e.stopPropagation(); openBoostModal(l); } }, `🚀 ${i18n.t('boost.button')}`) : null,
            el('button', { class: 'btn btn--ghost btn--small', onclick: async (e) => { e.stopPropagation(); const r = await api(`/listings/${l.id}/mark-completed`, { method: 'POST' }); showToast(r.transaction_completed ? i18n.t('toast.marked_completed') : i18n.t('toast.unmarked_completed')); loadMyListings(); } },
              l.transaction_completed ? i18n.t('mine.unmark_completed') : (l.listing_type === 'location' ? i18n.t('mine.mark_rented') : i18n.t('mine.mark_sold'))),
            el('button', { class: 'btn btn--danger btn--small', onclick: (e) => { e.stopPropagation(); deleteListing(l.id); } }, i18n.t('mine.delete')),
          ]),
        ]),
      ])
    );
  }
}
// ---------- Auth forms ----------
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('loginError');
  errEl.hidden = true;
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }) });
    onAuthSuccess(data);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
document.getElementById('registerIsProfessional').addEventListener('change', (e) => {
  document.getElementById('registerProFields').hidden = !e.target.checked;
  document.querySelector('#registerProFields input[name="company_name"]').required = e.target.checked;
});
document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('registerError');
  errEl.hidden = true;
  const isPro = fd.get('is_professional') === 'on';
  try {
    const data = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'), email: fd.get('email'), password: fd.get('password'), terms_accepted: fd.get('terms_accepted') === 'on',
        referral_code: new URLSearchParams(window.location.search).get('ref') || null,
        is_professional: isPro, company_name: fd.get('company_name'), company_website: fd.get('company_website'),
      }),
    });
    onAuthSuccess(data);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
function onAuthSuccess(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('atlas_token', data.token);
  localStorage.setItem('atlas_user', JSON.stringify(data.user));
  renderAuthZone();
  loadAiSettings();
  loadFavoriteIds();
  loadFavoriteDestinations();
  refreshAlertsBadge();
  document.getElementById('authModal').hidden = true;
  showToast(i18n.t('toast.welcome', { name: data.user.name }));
}
// ---------- Carte du monde (D3 + world-atlas) ----------
let mapSelection = null;
let countryPathsByIso = {};
async function initMap() {
  const container = document.getElementById('mapContainer');
  const width = container.clientWidth || 960;
  const height = width * (8.4 / 16);
  const svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${width} ${height}`);
  const projection = d3.geoNaturalEarth1().fitSize([width - 12, height - 12], { type: 'Sphere' });
  const path = d3.geoPath(projection);
  let world;
  try {
    world = await d3.json(WORLD_ATLAS_URL);
  } catch (e) {
    container.innerHTML = '<p style="padding:24px;color:rgba(241,233,216,.6)">La carte n\u2019a pas pu être chargée (pas de connexion internet). Vous pouvez tout de même explorer les pays via la liste ci-dessous.</p>';
    return;
  }
  const countries = topojson.feature(world, world.objects.countries);
  const listedIso = new Set(state.countries.filter((c) => c.listing_count > 0).map((c) => c.iso_numeric));
  const isoToCountry = {};
  state.countries.forEach((c) => (isoToCountry[String(Number(c.iso_numeric))] = c));
  const g = svg.append('g');
  const zoomLayer = g.append('g').attr('transform', 'translate(6,6)');
  zoomLayer
    .selectAll('path')
    .data(countries.features)
    .join('path')
    .attr('d', path)
    .attr('class', (d) => {
      const isoNum = String(Number(d.id));
      return 'country-shape' + (listedIso.has(isoNum) ? ' country-shape--listed' : '');
    })
    .attr('data-iso', (d) => String(Number(d.id)))
    .on('click', (event, d) => {
      const isoNum = String(Number(d.id));
      const match = isoToCountry[isoNum];
      if (match) {
        selectCountry(match);
      } else {
        showToast(i18n.t('toast.country_not_referenced'));
      }
    })
    .append('title')
    .text((d) => d.properties.name);
  try {
    const now = new Date();
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    const declination = -23.44 * Math.cos(((360 / 365) * (dayOfYear + 10) * Math.PI) / 180);
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
    const subsolarLon = -(utcHours - 12) * 15;
    const nightCenter = [((subsolarLon + 180 + 540) % 360) - 180, -declination];
    const nightCircle = d3.geoCircle().center(nightCenter).radius(90).precision(2)();
    zoomLayer.append('path').datum(nightCircle).attr('d', path).attr('class', 'night-overlay');
  } catch { /* décoratif uniquement : on ignore si d3.geoCircle n'est pas disponible */ }
  mapSelection = zoomLayer;
}
function highlightCountryOnMap(isoNumeric) {
  if (!mapSelection) return;
  mapSelection.selectAll('path').classed('country-shape--selected', false);
  if (isoNumeric) {
    mapSelection.selectAll(`path[data-iso="${String(Number(isoNumeric))}"]`).classed('country-shape--selected', true);
  }
}
// ---------- Messagerie ----------
let currentConversationId = null;
let lastKnownUnreadCount = 0;
async function refreshUnreadCount() {
  if (!state.user) return;
  try {
    const { count } = await api('/conversations/unread-count');
    const badge = document.getElementById('messagesBadge');
    badge.textContent = String(count);
    badge.hidden = count === 0;
    if (count > lastKnownUnreadCount) {
      showToast(i18n.t('toast.new_message'));
    }
    lastKnownUnreadCount = count;
  } catch { /* silencieux */ }
}
function startUnreadPolling() {
  setInterval(() => { if (state.user) { refreshUnreadCount(); refreshAlertsBadge(); } }, 25000);
}
function isUserBusy() {
  const modalOpen = document.querySelector('.modal-overlay:not([hidden])');
  const active = document.activeElement;
  const typing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
  return !!modalOpen || !!typing;
}
async function silentDataRefresh() {
  if (isUserBusy()) return;
  try {
    if (state.selectedCity && !document.getElementById('listingGrid').hidden) {
      await refreshListings();
    } else if (state.categoryBrowse.category && !document.getElementById('categoryBreadcrumb').hidden) {
      await runCategoryBrowseSearch();
    }
    if (!document.getElementById('featuredSection').hidden) {
      await loadFeatured();
    }
    await loadActivityTicker();
    await checkOpenListingForChanges();
  } catch {
    /* silencieux — nouvel essai au prochain cycle */
  }
}
/** Si une fiche annonce est actuellement ouverte, vérifie discrètement
 * si le prix ou la disponibilité ont changé depuis l'ouverture — utile
 * si quelqu'un laisse la fiche affichée un moment. N'écrase jamais
 * l'affichage tout seul : affiche juste un bandeau pour prévenir. */
let openListingSnapshot = null;
async function checkOpenListingForChanges() {
  if (!currentListingId || document.getElementById('listingModal').hidden) { openListingSnapshot = null; return; }
  try {
    const fresh = await api(`/listings/${currentListingId}`);
    if (openListingSnapshot && (fresh.price !== openListingSnapshot.price || fresh.status !== openListingSnapshot.status)) {
      const banner = document.getElementById('detailUpdateBanner');
      if (banner) banner.hidden = false;
    }
    openListingSnapshot = { price: fresh.price, status: fresh.status };
  } catch {
    /* silencieux */
  }
}
function startSilentRefresh() {
  setInterval(silentDataRefresh, 60000);
}
async function loadConversations() {
  try {
    const conversations = await api('/conversations');
    state.lists.conversations = conversations;
    renderConversationsList(conversations);
    if (conversations.length && !currentConversationId) openConversation(conversations[0].id);
  } catch (e) {
    showToast(e.message);
  }
}
function renderConversationsList(conversations) {
  const list = document.getElementById('conversationsList');
  list.innerHTML = '';
  if (conversations.length === 0) {
    list.append(el('p', { class: 'empty-state' }, i18n.t('messages.no_conversations')));
    return;
  }
  for (const c of conversations) {
    list.append(
      el('button', {
        class: `conversation-item ${currentConversationId === c.id ? 'is-active' : ''}`,
        onclick: () => openConversation(c.id),
      }, [
        c.listing_image ? el('img', { class: 'conversation-item-img', src: c.listing_image, alt: '' }) : el('div', { class: 'conversation-item-img' }),
        el('div', { class: 'conversation-item-body' }, [
          el('span', { class: 'conversation-item-name' }, c.other_user_name),
          el('span', { class: 'conversation-item-listing' }, c.listing_title),
          el('span', { class: 'conversation-item-preview' }, c.last_message || ''),
        ]),
        c.unread_count > 0 ? el('span', { class: 'nav-badge' }, String(c.unread_count)) : null,
      ])
    );
  }
}
async function openConversation(id) {
  currentConversationId = id;
  renderConversationsList(state.lists.conversations || []);
  try {
    const data = await api(`/conversations/${id}/messages`);
    renderConversationThread(data);
    refreshUnreadCount();
    loadConversations();
  } catch (e) {
    showToast(e.message);
  }
}
function renderConversationThread(data) {
  const thread = document.getElementById('conversationThread');
  thread.innerHTML = '';
  thread.append(
    el('div', { class: 'thread-header' }, [
      data.listing.image ? el('img', { class: 'thread-header-img', src: data.listing.image, alt: '' }) : el('div', { class: 'thread-header-img' }),
      el('div', {}, [
        el('span', { class: 'thread-header-name' }, data.other_user.name),
        el('button', { class: 'thread-header-listing', onclick: () => openListingDetail(data.listing.id) }, data.listing.title),
      ]),
    ])
  );
  if (data.other_user_is_seller) {
    thread.append(el('button', { class: 'rate-seller-link', onclick: () => openReviewModal(data.listing.id) }, i18n.t('review.rate_seller')));
  }
  const conversationReportBox = el('div', { class: 'report-box', hidden: 'true' });
  thread.append(
    el('button', {
      class: 'report-link',
      onclick: () => {
        conversationReportBox.hidden = !conversationReportBox.hidden;
        if (!conversationReportBox.hidden) renderReportBoxContent(conversationReportBox, data.listing.id);
      },
    }, i18n.t('report.link')),
    conversationReportBox
  );
  const timeline = [
    ...data.messages.map((m) => ({ kind: 'message', ...m })),
    ...(data.offers || []).map((o) => ({ kind: 'offer', ...o })),
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const messagesEl = el('div', { class: 'thread-messages' },
    timeline.map((item) => {
      const mine = (item.kind === 'message' ? item.sender_id : item.buyer_id) === state.user.id;
      if (item.kind === 'message') {
        return el('div', { class: `thread-message ${mine ? 'thread-message--mine' : ''}` }, [
          item.image_url ? el('img', { class: 'thread-message-image', src: item.image_url, alt: i18n.t('messages.image_alt'), onclick: () => window.open(item.image_url, '_blank') }) : null,
          item.body ? el('p', {}, item.body) : null,
          el('span', { class: 'thread-message-time' }, new Date(item.created_at).toLocaleString()),
        ].filter(Boolean));
      }
      const statusLabel = { pending: i18n.t('offer.status_pending'), accepted: i18n.t('offer.status_accepted'), rejected: i18n.t('offer.status_rejected') }[item.status];
      const bubble = el('div', { class: `offer-bubble ${mine ? '' : ''}` }, [
        el('span', { class: 'offer-amount' }, item.kind === 'echange' ? `🔄 ${item.trade_description}` : `💰 ${fmtPrice(item.amount, item.currency)}`),
        el('span', { class: `offer-status offer-status--${item.status}` }, statusLabel),
      ]);
      if (item.status === 'pending' && data.is_seller) {
        bubble.append(
          el('div', { class: 'offer-actions' }, [
            el('button', { class: 'btn btn--primary btn--small', onclick: async () => { await api(`/offers/${item.id}`, { method: 'PUT', body: JSON.stringify({ status: 'accepted' }) }); openConversation(data.id); } }, i18n.t('offer.accept')),
            el('button', { class: 'btn btn--ghost btn--small', onclick: async () => { await api(`/offers/${item.id}`, { method: 'PUT', body: JSON.stringify({ status: 'rejected' }) }); openConversation(data.id); } }, i18n.t('offer.reject')),
          ])
        );
      }
      return el('div', { class: `thread-message ${mine ? 'thread-message--mine' : ''}` }, [bubble]);
    })
  );
  thread.append(messagesEl);
  const textarea = el('textarea', { rows: '2', 'data-i18n-placeholder': 'messages.write_placeholder', placeholder: i18n.t('messages.write_placeholder') });
  let pendingMessageImageUrl = null;
  const imagePreviewEl = el('div', { class: 'message-image-preview', hidden: 'true' });
  function updateMessageImagePreview() {
    imagePreviewEl.innerHTML = '';
    if (!pendingMessageImageUrl) { imagePreviewEl.hidden = true; return; }
    imagePreviewEl.hidden = false;
    imagePreviewEl.append(
      el('img', { src: pendingMessageImageUrl, alt: i18n.t('messages.image_preview_alt') }),
      el('button', { type: 'button', 'aria-label': i18n.t('messages.remove_image'), onclick: () => { pendingMessageImageUrl = null; updateMessageImagePreview(); } }, '×')
    );
  }
  const photoInput = el('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', style: 'display:none;',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        pendingMessageImageUrl = await uploadImageFile(file);
        updateMessageImagePreview();
      } catch (err) {
        showToast(friendlyErrorMessage(err));
      }
      e.target.value = '';
    },
  });
  const send = async () => {
    const body = textarea.value.trim();
    if (!body && !pendingMessageImageUrl) return;
    try {
      await api(`/conversations/${data.id}/messages`, { method: 'POST', body: JSON.stringify({ body, image_url: pendingMessageImageUrl }) });
      textarea.value = '';
      pendingMessageImageUrl = null;
      openConversation(data.id);
    } catch (e) {
      showToast(friendlyErrorMessage(e));
    }
  };
  const offerForm = el('div', { class: 'offer-form', hidden: 'true' });
  thread.append(
    el('div', { class: 'thread-compose-wrap' }, [
      el('p', { class: 'form-notice' }, termsNoticeNode('terms.message_reminder_prefix')),
      offerForm,
      imagePreviewEl,
      el('div', { class: 'thread-compose' }, [
        photoInput,
        el('button', { type: 'button', class: 'attach-photo-link', title: i18n.t('messages.attach_photo'), 'aria-label': i18n.t('messages.attach_photo'), onclick: () => photoInput.click() }, '📷'),
        textarea,
        !data.is_seller ? el('button', { class: 'make-offer-link', onclick: () => { offerForm.hidden = !offerForm.hidden; renderOfferForm(offerForm, data.id); } }, `💰 ${i18n.t('offer.make_offer')}`) : null,
        el('button', { class: 'btn btn--primary', onclick: send }, i18n.t('messages.send')),
      ]),
    ])
  );
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function renderOfferForm(container, conversationId) {
  if (container.childNodes.length) return; // déjà rendu
  const kindSelect = el('select', {}, [
    el('option', { value: 'argent' }, i18n.t('offer.kind_money')),
    el('option', { value: 'echange' }, i18n.t('offer.kind_trade')),
  ]);
  const amountInput = el('input', { type: 'number', min: '1', step: '0.01', placeholder: i18n.t('offer.amount_placeholder') });
  const tradeInput = el('input', { type: 'text', placeholder: i18n.t('offer.trade_placeholder'), hidden: 'true' });
  const errorEl = el('p', { class: 'form-error', hidden: 'true' });
  kindSelect.addEventListener('change', () => {
    amountInput.hidden = kindSelect.value === 'echange';
    tradeInput.hidden = kindSelect.value !== 'echange';
  });
  container.append(
    el('div', { class: 'offer-form-row' }, [
      kindSelect,
      amountInput,
      tradeInput,
      el('button', { class: 'btn btn--primary btn--small', onclick: async () => {
        errorEl.hidden = true;
        const kind = kindSelect.value;
        if (kind === 'argent') {
          const amount = Number(amountInput.value);
          if (!amount || amount <= 0) { errorEl.textContent = i18n.t('offer.amount_required'); errorEl.hidden = false; return; }
          try {
            await api(`/conversations/${conversationId}/offers`, { method: 'POST', body: JSON.stringify({ kind, amount }) });
            openConversation(conversationId);
          } catch (e) {
            errorEl.textContent = friendlyErrorMessage(e);
            errorEl.hidden = false;
          }
        } else {
          if (!tradeInput.value.trim()) { errorEl.textContent = i18n.t('offer.trade_required'); errorEl.hidden = false; return; }
          try {
            await api(`/conversations/${conversationId}/offers`, { method: 'POST', body: JSON.stringify({ kind, trade_description: tradeInput.value.trim() }) });
            openConversation(conversationId);
          } catch (e) {
            errorEl.textContent = friendlyErrorMessage(e);
            errorEl.hidden = false;
          }
        }
      } }, i18n.t('offer.submit')),
    ]),
    errorEl
  );
}
async function loadAdminReports() {
  try {
    state.lists.adminReports = await api('/admin/reports');
    renderAdminReports(state.lists.adminReports);
  } catch (e) {
    showToast(e.message);
  }
}
function renderAdminReports(reports) {
  const body = document.getElementById('adminReportsBody');
  body.innerHTML = '';
  if (!reports || reports.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: '5' }, i18n.t('admin.no_reports'))));
    return;
  }
  const reasonLabels = { spam: 'report.reason_spam', hateful: 'report.reason_hateful', scam: 'report.reason_scam', other: 'report.reason_other' };
  for (const r of reports) {
    body.append(
      el('tr', {}, [
        el('td', {}, el('button', { class: 'btn btn--ghost btn--small', onclick: () => openListingDetail(r.listing_id) }, r.listing_title)),
        el('td', {}, `${i18n.t(reasonLabels[r.reason] || 'report.reason_other')}${r.details ? ' — ' + r.details : ''}`),
        el('td', {}, `${r.reporter_name} (${r.reporter_email})`),
        el('td', {}, i18n.t(`admin.report_status_${r.status}`)),
        el('td', {}, el('div', { class: 'admin-actions' }, r.status === 'open' ? [
          el('button', { class: 'btn btn--ghost btn--small', onclick: () => setReportStatus(r.id, 'dismissed') }, i18n.t('admin.dismiss_report')),
          el('button', { class: 'btn btn--danger btn--small', onclick: () => setReportStatus(r.id, 'resolved') }, i18n.t('admin.resolve_report')),
        ] : [])),
      ])
    );
  }
}
async function setReportStatus(id, status) {
  try {
    await api(`/admin/reports/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    showToast(i18n.t('toast.report_updated'));
    loadAdminReports();
  } catch (e) {
    showToast(e.message);
  }
}
async function loadAdminEmails() {
  try {
    state.lists.adminEmails = await api('/admin/emails');
    renderAdminEmails(state.lists.adminEmails);
  } catch (e) {
    showToast(e.message);
  }
}
function renderAdminEmails(emails) {
  const body = document.getElementById('adminEmailsBody');
  body.innerHTML = '';
  if (!emails || emails.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: '5' }, i18n.t('admin.no_emails'))));
    return;
  }
  for (const em of emails) {
    body.append(
      el('tr', {}, [
        el('td', {}, em.to_email),
        el('td', {}, em.subject),
        el('td', {}, em.sent_ok ? '✓' : `✗${em.send_error ? ' (' + em.send_error + ')' : ''}`),
        el('td', {}, new Date(em.created_at).toLocaleString()),
        el('td', {}, em.link ? el('button', { class: 'btn btn--ghost btn--small', onclick: () => { navigator.clipboard.writeText(em.link); showToast(i18n.t('toast.link_copied')); } }, i18n.t('admin.copy_link')) : null),
      ])
    );
  }
}
async function loadCategoryStatusList() {
  try {
    const categories = await api('/admin/categories');
    renderCategoryStatusList(categories);
  } catch (e) {
    showToast(e.message);
  }
}
function renderCategoryStatusList(categories) {
  const container = document.getElementById('adminCategoryStatusList');
  if (!container) return;
  container.innerHTML = '';
  for (const c of categories) {
    container.append(
      el('span', { class: `category-status-chip ${c.is_active ? 'is-active' : 'is-inactive'}` }, `${c.icon} ${categoryLabel(c)}`)
    );
  }
}
async function reactivateAllCategories() {
  try {
    const result = await api('/admin/categories/reactivate-all', { method: 'POST' });
    showToast(result.reactivated > 0 ? i18n.t('toast.categories_reactivated', { count: result.reactivated }) : i18n.t('toast.categories_all_active'));
    loadCategoryStatusList();
  } catch (e) {
    showToast(e.message);
  }
}
document.getElementById('reactivateAllCategoriesBtn')?.addEventListener('click', reactivateAllCategories);
function initAdminCategoryCountrySelector() {
  const select = document.getElementById('adminCategoryCountrySelect');
  if (!select || select.dataset.initialized) return;
  select.dataset.initialized = '1';
  for (const c of state.countries) {
    select.append(el('option', { value: c.id }, countryLabel(c)));
  }
  select.addEventListener('change', () => loadAdminCategoryCountryExclusions(select.value));
  if (select.options.length) loadAdminCategoryCountryExclusions(select.value);
}
async function loadAdminCategoryCountryExclusions(countryId) {
  try {
    const categories = await api(`/admin/countries/${countryId}/category-exclusions`);
    renderCategoryCountryChecklist(categories, Number(countryId));
  } catch (e) {
    showToast(e.message);
  }
}
function renderCategoryCountryChecklist(categories, countryId) {
  const container = document.getElementById('adminCategoryCountryChecklist');
  container.innerHTML = '';
  for (const c of categories) {
    const checkbox = el('input', {
      type: 'checkbox',
      checked: c.excluded ? null : 'checked',
      onchange: () => toggleCategoryCountryExclusion(c.id, countryId),
    });
    container.append(
      el('label', { class: 'admin-checklist-item' }, [checkbox, ` ${c.icon} ${categoryLabel(c)}`])
    );
  }
}
async function toggleCategoryCountryExclusion(categoryId, countryId) {
  try {
    const result = await api('/admin/category-country-exclusions/toggle', {
      method: 'POST',
      body: JSON.stringify({ category_id: categoryId, country_id: countryId }),
    });
    showToast(i18n.t(result.excluded ? 'toast.category_excluded_for_country' : 'toast.category_included_for_country'));
  } catch (e) {
    showToast(e.message);
  }
}
// ---------- Paramètres IA (clé API personnelle) ----------
state.aiSettings = { provider: null, has_key: false };
async function loadAiSettings() {
  if (!state.user) { state.aiSettings = { provider: null, has_key: false }; return; }
  try {
    state.aiSettings = await api('/me/ai-settings');
  } catch {
    state.aiSettings = { provider: null, has_key: false };
  }
}
function openAiSettingsModal() {
  const statusEl = document.getElementById('aiSettingsStatus');
  document.getElementById('aiSettingsError').hidden = true;
  document.getElementById('aiApiKeyInput').value = '';
  if (state.aiSettings.has_key) {
    document.getElementById('aiProviderSelect').value = state.aiSettings.provider;
    statusEl.textContent = i18n.t('ai.status_configured', { provider: state.aiSettings.provider === 'anthropic' ? 'Anthropic' : 'OpenAI' });
  } else {
    statusEl.textContent = i18n.t('ai.status_not_configured');
  }
  document.getElementById('aiSettingsModal').hidden = false;
}
document.getElementById('aiSettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('aiSettingsError');
  errEl.hidden = true;
  const apiKey = fd.get('api_key').trim();
  if (!apiKey) { errEl.textContent = i18n.t('ai.key_required'); errEl.hidden = false; return; }
  try {
    state.aiSettings = await api('/me/ai-settings', { method: 'PUT', body: JSON.stringify({ provider: fd.get('provider'), api_key: apiKey }) });
    showToast(i18n.t('toast.ai_key_saved'));
    document.getElementById('aiSettingsModal').hidden = true;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
document.getElementById('aiRemoveKeyBtn').addEventListener('click', async () => {
  try {
    state.aiSettings = await api('/me/ai-settings', { method: 'PUT', body: JSON.stringify({ api_key: '' }) });
    showToast(i18n.t('toast.ai_key_removed'));
    document.getElementById('aiSettingsModal').hidden = true;
  } catch (err) {
    showToast(err.message);
  }
});
async function translateListingInline(listing, containerEl) {
  containerEl.innerHTML = '';
  containerEl.append(el('p', { class: 'ai-translating' }, i18n.t('ai.translating')));
  try {
    const result = await api('/ai/translate-listing', {
      method: 'POST',
      body: JSON.stringify({ listing_id: listing.id, target_lang: i18n.effectiveLang() }),
    });
    containerEl.innerHTML = '';
    containerEl.append(
      el('div', { class: 'ai-translation' }, [
        el('span', { class: 'ai-translation-badge' }, i18n.t('ai.translated_badge')),
        el('h3', {}, result.title),
        el('p', {}, result.description || ''),
      ])
    );
  } catch (err) {
    containerEl.innerHTML = '';
    containerEl.append(el('p', { class: 'form-error' }, friendlyErrorMessage(err)));
  }
}
// ---------- Notation des vendeurs ----------
let reviewListingId = null;
function openReviewModal(listingId) {
  reviewListingId = listingId;
  document.getElementById('reviewRatingInput').value = '0';
  document.getElementById('reviewForm').reset();
  document.getElementById('reviewError').hidden = true;
  document.querySelectorAll('#starPicker button').forEach((b) => b.classList.remove('active'));
  document.getElementById('reviewModal').hidden = false;
}
document.querySelectorAll('#starPicker button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const value = Number(btn.dataset.value);
    document.getElementById('reviewRatingInput').value = String(value);
    document.querySelectorAll('#starPicker button').forEach((b) => b.classList.toggle('active', Number(b.dataset.value) <= value));
  });
});
document.getElementById('reviewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById('reviewError');
  errEl.hidden = true;
  const rating = Number(fd.get('rating'));
  if (!rating) { errEl.textContent = i18n.t('review.rating_required'); errEl.hidden = false; return; }
  try {
    await api('/reviews', { method: 'POST', body: JSON.stringify({ listing_id: reviewListingId, rating, comment: fd.get('comment') }) });
    showToast(i18n.t('toast.review_submitted'));
    document.getElementById('reviewModal').hidden = true;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});
// ---------- Administration ----------
document.querySelectorAll('[data-admin-tab]').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-admin-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    document.getElementById('adminDashboardPanel').hidden = btn.dataset.adminTab !== 'dashboard';
    document.getElementById('adminUsersPanel').hidden = btn.dataset.adminTab !== 'users';
    document.getElementById('adminListingsPanel').hidden = btn.dataset.adminTab !== 'listings';
    document.getElementById('adminReportsPanel').hidden = btn.dataset.adminTab !== 'reports';
    document.getElementById('adminEmailsPanel').hidden = btn.dataset.adminTab !== 'emails';
    document.getElementById('adminCategoriesPanel').hidden = btn.dataset.adminTab !== 'categories';
    document.getElementById('adminCityRequestsPanel').hidden = btn.dataset.adminTab !== 'city-requests';
    if (btn.dataset.adminTab === 'city-requests') loadCityRequests();
  })
);
let addCityFormInitialized = false;
async function handleAddCityCountryChange() {
  const select = document.getElementById('addCityCountrySelect');
  const tzInput = document.getElementById('addCityTimezoneInput');
  const stateRow = document.getElementById('addCityStateRow');
  const stateSelect = document.getElementById('addCityStateSelect');
  stateSelect.innerHTML = '';
  if (!select.value) { stateRow.hidden = true; return; }
  const isFederal = select.selectedOptions[0]?.dataset.isFederal === '1';
  if (isFederal) {
    stateRow.hidden = false;
    tzInput.value = '';
    try {
      const states = await api(`/countries/${select.value}/states`);
      for (const st of states) stateSelect.append(el('option', { value: st.id }, st.name));
      stateSelect.dispatchEvent(new Event('change'));
    } catch { /* pas grave, l'admin peut le saisir à la main */ }
  } else {
    stateRow.hidden = true;
    try {
      const cities = await api(`/countries/${select.value}/cities`);
      if (cities.length > 0) tzInput.value = cities[0].timezone;
    } catch { /* pas grave, l'admin peut le saisir à la main */ }
  }
}
function initAddCityForm() {
  if (addCityFormInitialized) return;
  addCityFormInitialized = true;
  const select = document.getElementById('addCityCountrySelect');
  for (const c of [...state.countries].sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)))) {
    select.append(el('option', { value: c.id, 'data-is-federal': c.is_federal ? '1' : '' }, countryLabel(c)));
  }
  select.addEventListener('change', handleAddCityCountryChange);
  document.getElementById('addCityStateSelect').addEventListener('change', async (e) => {
    const tzInput = document.getElementById('addCityTimezoneInput');
    if (!e.target.value) return;
    try {
      const cities = await api(`/states/${e.target.value}/cities`);
      if (cities.length > 0) tzInput.value = cities[0].timezone;
    } catch { /* pas grave, l'admin peut le saisir à la main */ }
  });
  document.getElementById('addCitySubmitBtn').addEventListener('click', async () => {
    const countryId = document.getElementById('addCityCountrySelect').value;
    const stateRow = document.getElementById('addCityStateRow');
    const stateId = !stateRow.hidden ? document.getElementById('addCityStateSelect').value : null;
    const name = document.getElementById('addCityNameInput').value.trim();
    const timezone = document.getElementById('addCityTimezoneInput').value.trim();
    if (!countryId || !name || !timezone || (!stateRow.hidden && !stateId)) { showToast(i18n.t('admin.add_city_missing_fields')); return; }
    try {
      await api('/admin/cities', { method: 'POST', body: JSON.stringify({ country_id: countryId, state_id: stateId, name, timezone }) });
      showToast(i18n.t('admin.add_city_success', { name }));
      document.getElementById('addCityNameInput').value = '';
      loadCityRequests();
    } catch (e) {
      showToast(e.message);
    }
  });
}
/** Pré-remplit le formulaire d'ajout à partir d'une demande en attente —
 * évite de retaper le nom de la ville et le pays. */
async function prefillAddCityForm(countryId, cityName, stateId) {
  document.getElementById('addCityCountrySelect').value = String(countryId);
  await handleAddCityCountryChange();
  if (stateId) document.getElementById('addCityStateSelect').value = String(stateId);
  document.getElementById('addCityNameInput').value = cityName;
  document.getElementById('addCityNameInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function loadCityRequests() {
  initAddCityForm();
  try {
    const requests = await api('/admin/city-requests');
    const body = document.getElementById('adminCityRequestsBody');
    body.innerHTML = '';
    for (const r of requests) {
      body.append(
        el('tr', {}, [
          el('td', {}, r.city_name),
          el('td', {}, r.state_name ? `${listingCountryLabel(r)} (${r.state_name})` : listingCountryLabel(r)),
          el('td', {}, r.email),
          el('td', {}, r.message || '—'),
          el('td', {}, el('span', { class: `city-request-status city-request-status--${r.status}` }, i18n.t(`city_request.status_${r.status}`))),
          el('td', {}, new Date(r.created_at).toLocaleDateString()),
          el('td', { style: 'display:flex;gap:6px;' }, r.status === 'pending' ? [
            el('button', {
              class: 'btn btn--ghost btn--small',
              onclick: () => prefillAddCityForm(r.country_id, r.city_name, r.state_id),
            }, i18n.t('admin.prefill_from_request')),
            el('button', {
              class: 'btn btn--ghost btn--small',
              onclick: async (e) => {
                e.target.disabled = true;
                try {
                  await api(`/admin/city-requests/${r.id}/fulfill`, { method: 'POST' });
                  showToast(i18n.t('city_request.fulfilled_toast'));
                  loadCityRequests();
                } catch (err) {
                  showToast(err.message);
                  e.target.disabled = false;
                }
              },
            }, i18n.t('city_request.mark_fulfilled')),
          ] : null),
        ])
      );
    }
  } catch (e) {
    showToast(e.message);
  }
}
async function loadAdminStats() {
  try {
    state.lists.adminStats = await api('/admin/stats');
    renderAdminDashboard(state.lists.adminStats);
  } catch (e) {
    showToast(e.message);
  }
}
function renderAdminDashboard(stats) {
  const cards = document.getElementById('dashboardCards');
  cards.innerHTML = '';
  const items = [
    ['card_users', stats.totalUsers, false],
    ['card_admins', stats.totalAdmins, true],
    ['card_active_listings', stats.activeListings, false],
    ['card_suspended_listings', stats.suspendedListings, false],
    ['card_new_listings_7d', stats.newListings7d, true],
    ['card_new_users_7d', stats.newUsers7d, true],
    ['card_countries_active', stats.countriesWithListings, false],
    ['card_total_visits', stats.totalVisits, true],
    ['card_visits_7d', stats.visits7d, false],
  ];
  for (const [key, value, accent] of items) {
    cards.append(
      el('div', { class: `dashboard-card ${accent ? 'dashboard-card--accent' : ''}` }, [
        el('span', { class: 'dashboard-card-value' }, String(value)),
        el('span', { class: 'dashboard-card-label' }, i18n.t(`admin.${key}`)),
      ])
    );
  }
  renderHorizontalBarChart('dashboardCategoryChart', stats.byCategory.map((c) => ({ label: `${c.icon} ${categoryLabel(c)}`, value: c.count })));
  renderHorizontalBarChart('dashboardTypeChart', stats.byType.map((t) => ({ label: listingTypeLabel(t.listing_type), value: t.count })));
  renderHorizontalBarChart('dashboardCountryChart', stats.byCountry.map((c) => ({ label: c.name, value: c.count })));
  renderVerticalBarChart('dashboardActivityChart', stats.daily);
  if (stats.dailyVisits) renderVerticalBarChart('dashboardVisitsChart', stats.dailyVisits);
}
function renderHorizontalBarChart(containerId, items) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!items.length || items.every((i) => i.value === 0)) {
    container.append(el('p', { class: 'bar-chart-empty' }, i18n.t('admin.chart_empty')));
    return;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  for (const item of items) {
    container.append(
      el('div', { class: 'bar-row' }, [
        el('span', { class: 'bar-row-label' }, item.label),
        el('div', { class: 'bar-row-track' }, el('div', { class: 'bar-row-fill', style: `width:${(item.value / max) * 100}%` })),
        el('span', { class: 'bar-row-value' }, String(item.value)),
      ])
    );
  }
}
function renderVerticalBarChart(containerId, daily) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const max = Math.max(...daily.map((d) => d.count), 1);
  for (const d of daily) {
    const bar = el('div', { class: 'bar-col' }, el('div', { class: 'bar-col-fill', style: `height:${Math.max((d.count / max) * 100, 2)}%` }));
    bar.title = `${d.day} — ${d.count}`;
    container.append(bar);
  }
}
async function loadAdminUsers() {
  try {
    state.lists.adminUsers = await api('/admin/users');
    renderAdminUsers(state.lists.adminUsers);
  } catch (e) {
    showToast(e.message);
  }
}
function renderAdminUsers(users) {
  const body = document.getElementById('adminUsersBody');
  body.innerHTML = '';
  if (!users || users.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: '6' }, i18n.t('admin.no_users'))));
    return;
  }
  for (const u of users) {
    const isAdmin = u.role === 'admin';
    const isSelf = state.user && state.user.id === u.id;
    body.append(
      el('tr', {}, [
        el('td', {}, u.name),
        el('td', {}, u.email),
        el('td', {}, el('span', { class: `role-badge ${isAdmin ? 'role-badge--admin' : ''}` }, i18n.t(isAdmin ? 'admin.role_admin' : 'admin.role_user'))),
        el('td', {}, String(u.listing_count)),
        el('td', {}, new Date(u.created_at).toLocaleDateString()),
        el('td', {}, el('div', { class: 'admin-actions' }, [
          isAdmin
            ? el('button', { class: 'btn btn--ghost btn--small', onclick: () => setUserRole(u.id, 'user'), disabled: isSelf ? 'true' : null }, i18n.t('admin.demote'))
            : el('button', { class: 'btn btn--ghost btn--small', onclick: () => setUserRole(u.id, 'admin') }, i18n.t('admin.promote')),
          el('button', { class: 'btn btn--danger btn--small', onclick: () => deleteUser(u.id), disabled: isSelf ? 'true' : null }, i18n.t('admin.delete_user')),
        ])),
      ])
    );
  }
}
async function setUserRole(id, role) {
  try {
    await api(`/admin/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
    showToast(i18n.t('toast.role_updated'));
    loadAdminUsers();
  } catch (e) {
    showToast(e.message);
  }
}
async function deleteUser(id) {
  if (!confirm(i18n.t('admin.confirm_delete_user'))) return;
  try {
    await api(`/admin/users/${id}`, { method: 'DELETE' });
    showToast(i18n.t('toast.user_deleted'));
    loadAdminUsers();
  } catch (e) {
    showToast(e.message);
  }
}
async function loadAdminListings() {
  try {
    state.lists.adminListings = await api('/admin/listings');
    renderAdminListings(state.lists.adminListings);
  } catch (e) {
    showToast(e.message);
  }
}
function renderAdminListings(listings) {
  const body = document.getElementById('adminListingsBody');
  body.innerHTML = '';
  if (!listings || listings.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: '6' }, i18n.t('admin.no_listings'))));
    return;
  }
  for (const l of listings) {
    const isActive = l.status === 'active';
    const riskLevel = l.fraud_risk_score >= 4 ? 'high' : l.fraud_risk_score >= 2 ? 'medium' : 'low';
    const analysisBox = el('div', { class: 'fraud-analysis-box', hidden: 'true' });
    const riskCell = el('td', {}, [
      el('span', { class: `fraud-score fraud-score--${riskLevel}` }, String(l.fraud_risk_score)),
      l.fraud_risk_reasons ? el('p', { class: 'fraud-reasons' }, l.fraud_risk_reasons) : null,
      state.aiSettings.has_key
        ? el('button', { class: 'btn btn--ghost btn--small', onclick: async () => {
            analysisBox.hidden = false;
            analysisBox.textContent = i18n.t('admin.analyzing');
            try {
              const result = await api('/ai/analyze-fraud', { method: 'POST', body: JSON.stringify({ listing_id: l.id }) });
              analysisBox.innerHTML = '';
              analysisBox.append(el('p', {}, result.assessment), el('p', { class: 'th' }, result.recommendation));
            } catch (e) {
              analysisBox.textContent = friendlyErrorMessage(e);
            }
          } }, `✨ ${i18n.t('admin.analyze_ai')}`)
        : null,
      analysisBox,
    ]);
    body.append(
      el('tr', {}, [
        el('td', {}, el('button', { class: 'btn btn--ghost btn--small', onclick: () => openListingDetail(l.id) }, l.title)),
        el('td', {}, `${l.owner_name} (${l.owner_email})`),
        el('td', {}, `${l.city_name}, ${listingCountryLabel(l)}`),
        riskCell,
        el('td', {}, i18n.t(isActive ? 'admin.status_active' : 'admin.status_suspended')),
        el('td', {}, el('div', { class: 'admin-actions' }, [
          isActive
            ? el('button', { class: 'btn btn--ghost btn--small', onclick: () => setListingStatus(l.id, 'suspended') }, i18n.t('admin.suspend'))
            : el('button', { class: 'btn btn--ghost btn--small', onclick: () => setListingStatus(l.id, 'active') }, i18n.t('admin.reactivate')),
          el('button', { class: 'btn btn--danger btn--small', onclick: () => removeListingAsAdmin(l.id) }, i18n.t('admin.remove_listing')),
        ])),
      ])
    );
  }
}
async function setListingStatus(id, status) {
  try {
    await api(`/listings/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    showToast(i18n.t(status === 'active' ? 'toast.listing_reactivated' : 'toast.listing_suspended'));
    loadAdminListings();
    loadAdminStats();
  } catch (e) {
    showToast(e.message);
  }
}
async function removeListingAsAdmin(id) {
  if (!confirm(i18n.t('admin.confirm_remove_listing'))) return;
  try {
    await api(`/listings/${id}`, { method: 'DELETE' });
    showToast(i18n.t('toast.listing_deleted'));
    loadAdminListings();
  } catch (e) {
    showToast(e.message);
  }
}
// ---------- Langue ----------
function refreshCountryTexts() {
  const pubCountry = document.getElementById('publishCountry');
  if (pubCountry) {
    for (const opt of pubCountry.options) {
      const c = findCountryById(opt.value);
      if (c) opt.textContent = countryLabel(c);
    }
  }
  if (state.selectedCountry) {
    const searchInput = document.getElementById('countrySearchInput');
    if (searchInput) searchInput.value = countryLabel(state.selectedCountry);
    const activeCountryHeading = document.getElementById('activeCountryHeading');
    if (activeCountryHeading && !activeCountryHeading.hidden) activeCountryHeading.textContent = countryLabel(state.selectedCountry);
    const eyebrow = document.getElementById('coordEyebrow');
    if (eyebrow) {
      if (state.selectedCity) {
        eyebrow.textContent = `${state.selectedCity.name.toUpperCase()}, ${countryLabel(state.selectedCountry).toUpperCase()}`;
      } else if (state.selectedState) {
        eyebrow.textContent = `${state.selectedState.name.toUpperCase()}, ${countryLabel(state.selectedCountry).toUpperCase()} — ${i18n.t('eyebrow.choose_city_suffix')}`;
      } else {
        const suffixKey = state.selectedCountry.is_federal ? 'eyebrow.choose_state_suffix' : 'eyebrow.choose_city_suffix';
        eyebrow.textContent = `${countryLabel(state.selectedCountry).toUpperCase()} — ${i18n.t(suffixKey)}`;
      }
    }
    const countryModal = document.getElementById('countryModal');
    if (countryModal && !countryModal.hidden) {
      const h2 = countryModal.querySelector('.country-sheet-title h2');
      if (h2) h2.textContent = countryLabel(state.selectedCountry);
    }
  }
  const passportView = document.getElementById('view-passport');
  if (state.user && passportView && !passportView.hidden) loadPassport();
}
function onLanguageApplied() {
  renderAuthZone();
  renderStatsBar();
  renderBreadcrumb();
  if (state.lastStates) renderStateTiles(state.lastStates);
  if (state.lastCities) renderCityTiles(state.lastCities);
  const pubCat = document.getElementById('publishCategory');
  if (pubCat) updatePublishTypeAndPriceUI(findCategoryById(pubCat.value));
  const publishNotice = document.getElementById('publishTermsNotice');
  if (publishNotice) { publishNotice.innerHTML = ''; publishNotice.append(termsNoticeNode('terms.publish_reminder_prefix')); }
  const catFilter = document.getElementById('categoryFilter');
  if (catFilter) updateTypeFilterOptions(catFilter.value);
  if (state.lists.adminUsers.length) renderAdminUsers(state.lists.adminUsers);
  if (state.lists.adminListings.length) renderAdminListings(state.lists.adminListings);
  if (state.lists.adminStats) renderAdminDashboard(state.lists.adminStats);
  if (state.lists.favorites.length) renderCardsInto('favoritesGrid', state.lists.favorites);
  refreshCategoryTexts();
  refreshCountryTexts();
  rerenderAllPrices();
}
function initLanguagePicker() {
  const select = document.getElementById('langSelect');
  i18n.populateSelector(select);
  select.addEventListener('change', () => i18n.setLanguage(select.value));
  i18n.apply();
}
document.getElementById('resendVerificationBtn').addEventListener('click', async () => {
  try {
    await api('/auth/resend-verification', { method: 'POST' });
    showToast(i18n.t('toast.verification_resent'));
  } catch (e) {
    showToast(e.message);
  }
});
async function handleAuthLinksFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const listingId = params.get('listing');
  if (listingId) {
    openListingDetail(Number(listingId));
    window.history.replaceState({}, '', window.location.pathname);
  }
  const verifyToken = params.get('verify');
  const resetToken = params.get('reset');
  if (verifyToken) {
    try {
      await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });
      showToast(i18n.t('toast.email_verified'));
      if (state.token) {
        try {
          const { user } = await api('/auth/me');
          state.user = user;
          localStorage.setItem('atlas_user', JSON.stringify(user));
        } catch { /* on retentera au prochain chargement de page */ }
      }
      renderAuthZone();
    } catch (e) {
      showToast(e.message);
    }
    window.history.replaceState({}, '', window.location.pathname);
  }
  if (resetToken) {
    pendingResetToken = resetToken;
    openAuthModal('reset');
    window.history.replaceState({}, '', window.location.pathname);
  }
}
// ---------- Boot ----------
// ---------- Connexion Google (optionnelle, si configurée) ----------
async function initGoogleSignIn() {
  try {
    const config = await api('/config');
    if (!config.google_client_id) return;
    document.getElementById('googleSignInBox').hidden = false;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      google.accounts.id.initialize({ client_id: config.google_client_id, callback: handleGoogleCredential });
      google.accounts.id.renderButton(document.getElementById('googleSignInDiv'), { theme: 'outline', size: 'large', width: 320 });
    };
    document.head.appendChild(script);
  } catch { /* config indisponible : le bouton Google reste masqué */ }
}
async function handleGoogleCredential(response) {
  if (!document.getElementById('googleTermsCheckbox').checked) {
    showToast(i18n.t('auth.terms_required_google'));
    return;
  }
  try {
    const data = await api('/auth/google', { method: 'POST', body: JSON.stringify({ id_token: response.credential, terms_accepted: true }) });
    onAuthSuccess(data);
  } catch (e) {
    showToast(friendlyErrorMessage(e));
  }
}
function handleInitialUrlRoute() {
  const path = window.location.pathname;
  let m;
  if ((m = path.match(/^\/pays\/([a-z0-9-]+)\/([a-z0-9-]+)$/))) {
    const country = (state.countries || []).find((c) => slugify(c.name) === m[1]);
    if (country) {
      navigate('explore');
      selectCountry(country).then(() => {
        const citySlug = m[2];
        const cities = state.lastCities || [];
        const city = cities.find((c) => slugify(c.name) === citySlug);
        if (city) selectCity(city);
      });
    }
    return;
  }
  if ((m = path.match(/^\/pays\/([a-z0-9-]+)$/))) {
    const country = (state.countries || []).find((c) => slugify(c.name) === m[1]);
    if (country) { navigate('explore'); selectCountry(country); }
    return;
  }
  if ((m = path.match(/^\/annonce\/(\d+)/))) {
    navigate('explore');
    openListingDetail(Number(m[1]));
    return;
  }
  if ((m = path.match(/^\/categorie\/([a-z0-9-]+)$/))) {
    const category = (state.categories || []).find((c) => c.slug === m[1]);
    if (category) browseCategory(category);
    return;
  }
}
function trackSiteVisit() {
  if (sessionStorage.getItem('atlas_visit_tracked')) return;
  sessionStorage.setItem('atlas_visit_tracked', '1');
  api('/track-visit', { method: 'POST' }).catch(() => { /* silencieux */ });
}
/** Ouvre la modale de signalement de ville manquante, préremplit l'email
 * si l'utilisateur est connecté. */
async function openCityRequestModal() {
  const form = document.getElementById('cityRequestForm');
  form.reset();
  if (state.user && state.user.email) {
    document.getElementById('cityRequestEmail').value = state.user.email;
  }
  const stateRow = document.getElementById('cityRequestStateRow');
  const stateSelect = document.getElementById('cityRequestStateSelect');
  stateSelect.innerHTML = '';
  if (state.selectedCountry && state.selectedCountry.is_federal) {
    stateRow.hidden = false;
    try {
      const states = await api(`/countries/${state.selectedCountry.id}/states`);
      for (const st of states) stateSelect.append(el('option', { value: st.id }, st.name));
    } catch { /* pas grave, le champ reste vide */ }
  } else {
    stateRow.hidden = true;
  }
  document.getElementById('cityRequestModal').hidden = false;
}
document.getElementById('cityMissingContactBtn')?.addEventListener('click', openCityRequestModal);
document.getElementById('cityRequestForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedCountry) { showToast(i18n.t('city_request.no_country')); return; }
  const stateRow = document.getElementById('cityRequestStateRow');
  try {
    await api('/city-requests', {
      method: 'POST',
      body: JSON.stringify({
        country_id: state.selectedCountry.id,
        state_id: !stateRow.hidden ? document.getElementById('cityRequestStateSelect').value : null,
        city_name: document.getElementById('cityRequestCityName').value.trim(),
        email: document.getElementById('cityRequestEmail').value.trim(),
        message: document.getElementById('cityRequestMessage').value.trim(),
      }),
    });
    document.getElementById('cityRequestModal').hidden = true;
    showToast(i18n.t('city_request.submitted'));
  } catch (err) {
    showToast(err.message);
  }
});
async function boot() {
  initLanguagePicker();
  trackSiteVisit();
  renderAuthZone();
  if (state.token) {
    try {
      const { user } = await api('/auth/me');
      state.user = user;
      localStorage.setItem('atlas_user', JSON.stringify(user));
      renderAuthZone();
    } catch {
      /* jeton expiré ou serveur injoignable : on garde l'affichage précédent */
    }
  }
  loadAiSettings();
  loadFavoriteIds();
  loadFavoriteDestinations();
  refreshAlertsBadge();
  renderRecentlyViewed();
  renderRecentPlaces();
  try {
    await Promise.all([loadCategories(), loadCountries()]);
    loadFeatured();
    loadPromoBanner();
    loadActivityTicker();
    loadExchangeRates();
  } catch (e) {
    showToast(i18n.t('toast.server_unreachable'));
  }
  initMap();
  initGoogleSignIn();
  handleAuthLinksFromUrl();
  handleInitialUrlRoute();
  window.addEventListener('popstate', handleInitialUrlRoute);
  startUnreadPolling();
  startSilentRefresh();
  setTimeout(maybeShowGuideOnFirstVisit, 1200);
}
boot();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* installation impossible, site reste utilisable normalement */ });
  });
}
