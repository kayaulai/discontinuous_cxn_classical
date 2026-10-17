/* =========================================================================
   SITE SETTINGS — the site's owner edits these. Anything left empty is
   simply not shown (or shown as a [placeholder] in the citation).
   ========================================================================= */
const SITE_CONFIG = {
  siteName: 'Collomap',
  datasetTitle: '',   // e.g. 'Collocations in pre-Qin and Han philosophical texts'
  authors: '',        // e.g. 'Lai, Kay'
  year: '',           // defaults to the current year
  url: '',            // defaults to this page's address when served over the web
  license: '',        // shown in the footer, e.g. 'Data: CC BY 4.0'
  sourceUrl: '',      // link to the data / code repository; hidden if empty
  about: '',          // a few sentences about the dataset (blank line = new paragraph)
  groupNames: null,   // { first: 'Adverb', second: 'Final particle' }
  defaultDistance: '',// 'asym' (one-way pull) or 'sym' (mutual strength)
  defaultSpacing: '', // 'rank', 'raw' or 'log'
  sampleText: ''      // passage pre-filled in the "try it on your own text" box
};

// A site built with build_site.py ships its data and settings in data.js. In that
// "fixed" mode the data opens by itself and all upload features are hidden.
const FIXED = !!window.COLLOMAP_DATA;
Object.assign(SITE_CONFIG, window.COLLOMAP_SITE || {});

const DEFAULT_LABELS = { slot1: 'First word', slot2: 'Second word' };
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

/* =========================================================================
   STATE
   ========================================================================= */
const App = {
  rows: [],                 // parsed pairs
  slot1: new Map(),         // word -> {id,label,slot,attrs:{type:Set},edges:[rowIdx]}
  slot2: new Map(),
  attrSchema: { w1:{}, w2:{}, pair:{} }, // type -> Set(values)
  filters: { w1:{}, w2:{}, pair:{} },    // type -> Set(selected values)
  labels: { ...DEFAULT_LABELS },         // what the two groups of words are called on screen
  datasetName: '',
  metric: 'asym',           // 'asym' | 'sym'
  scale: 'rank',            // 'rank' | 'raw' | 'log'
  animationEnabled: true,
  animationThreshold: 60,   // auto-disable animation above this many nodes in the target view
  lastNodeCount: 0,
  overviewPositions: null,  // cached SVD-derived {word id -> {x,y}}, recomputed only on data load
  examples: new Map(),      // "word1|word2" (lowercased) -> array of example objects
  wordListExpanded: { w1: false, w2: false },
  wordQuery: '',
  defaultText: '',          // sample passage currently in the "own text" box (so we can clear it)
  collocateSort: { col: null, dir: 'desc' },
  cy: null,
  focal: null               // {id, slot, word}
};

/* =========================================================================
   SMALL HELPERS
   ========================================================================= */
const $ = id => document.getElementById(id);
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }

// "attr" column names become readable headings: "semantic_field" -> "Semantic field"
function pretty(s) {
  const t = String(s).replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Accepts 'w1'/'w2' (filter scopes) or 'slot1'/'slot2' (graph nodes)
function labelFor(scope) {
  return (scope === 'w1' || scope === 'slot1') ? App.labels.slot1 : App.labels.slot2;
}

let noticeTimer = null;
// A friendly message banner over the picture; replaces browser alert() boxes.
function notify(message, kind = 'info', sticky = false) {
  const box = $('notice');
  $('notice-text').textContent = message;
  box.className = 'notice' + (kind === 'info' ? '' : ' ' + kind);
  box.hidden = false;
  clearTimeout(noticeTimer);
  if (!sticky) noticeTimer = setTimeout(() => { box.hidden = true; }, kind === 'info' ? 7000 : 14000);
}
function hideNotice() { $('notice').hidden = true; clearTimeout(noticeTimer); }

// Dialogs: remember where focus was so keyboard users land back there
let lastFocused = null;
function openModal(id) {
  lastFocused = document.activeElement;
  const el = $(id);
  el.style.display = 'flex';
  const close = el.querySelector('.modal-close');
  if (close) close.focus();
}
function closeModal(id) {
  const el = $(id);
  if (el.style.display === 'none') return;
  el.style.display = 'none';
  if (lastFocused && lastFocused.focus) { try { lastFocused.focus(); } catch (e) {} }
}

function downloadText(filename, text) {
  // leading BOM so Excel opens UTF-8 files (Chinese etc.) correctly
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const SAMPLE_CSV = `word1,word2,sym_score,asym_score,asym_score_2,attr_pair_construction,attr_w1_domain,attr_w2_domain
strong,coffee,12.4,0.61,0.34,literal,intensity,beverage
strong,tea,6.1,0.30,0.24,literal,intensity,beverage
strong,wind,15.2,0.55,0.50,literal,intensity,weather
strong,economy,9.8,0.40,0.24,metaphorical,intensity,abstract
heavy,rain,18.7,0.70,0.70,literal,intensity,weather
heavy,traffic,14.3,0.58,0.41,metaphorical,intensity,abstract
heavy,coffee,3.2,0.12,0.07,literal,intensity,beverage
big,house,22.1,0.66,0.73,literal,size,building
big,decision,7.4,0.35,0.21,metaphorical,size,abstract
big,deal,11.0,0.50,0.45,idiomatic,size,abstract
large,house,19.5,0.60,0.66,literal,size,building
large,amount,25.3,0.72,0.72,literal,size,abstract
fresh,coffee,8.9,0.44,0.24,literal,novelty,beverage
fresh,air,20.4,0.68,0.82,literal,novelty,weather
fresh,start,13.7,0.55,0.39,metaphorical,novelty,abstract
bright,future,16.2,0.62,0.50,metaphorical,luminosity,abstract
bright,light,24.8,0.75,0.83,literal,luminosity,weather
bright,idea,10.3,0.48,0.29,idiomatic,luminosity,abstract
cold,coffee,9.1,0.40,0.22,literal,temperature,beverage
cold,wind,21.6,0.71,0.64,literal,temperature,weather
cold,war,5.5,0.28,0.14,idiomatic,temperature,abstract
學,習,10.2,0.58,0.46,classical,cognition,cognition
有,朋,9.4,0.52,0.47,classical,existential,social`;

// Optional companion table: one row per example sentence, joined back to a
// collocation pair by word1/word2. trans1/trans2 are substrings within
// `translation` to highlight as corresponding to word1/word2 respectively —
// same color-coding as the original text, so correspondence reads directly
// off the color rather than position. Demonstrates a mix of tiers: a
// curated ctext_urn (precise), a chapter name the built-in lookup resolves
// automatically, and plain sentences with no source metadata at all
// (fall back to a CText search link). The second strong/coffee row has a
// deliberately long gap between the two collocates, to demo the KWIC
// view's collapse/expand-the-gap behavior on a case with no real
// linguistic stakes riding on it.
const SAMPLE_EXAMPLES_CSV = `word1,word2,text,translation,ud_sent_id,work,chapter,ctext_urn,source_label,trans1,trans2
strong,coffee,The strong coffee kept him awake through the meeting.,,,,,,,,
strong,coffee,"The strong, bitter, over-brewed, lukewarm and faintly metallic-tasting coffee that had been sitting on the warming plate since early that morning finally got poured down the sink.",,,,,,,,
big,house,They finally bought a big house near the coast.,,,,,,,,
學,習,學而時習之，不亦說乎,"To learn, and then to practice it in due time — is that not a joy?",lzh_kyoto-train-00042,論語,學而,,Analects 1.1,learn,practice
有,朋,有朋自遠方來，不亦樂乎,"To have friends come from distant places — is that not delightful?",lzh_kyoto-train-00043,論語,,ctp:analects/xue-er,Analects 1.1,have,friends`;

/* -------------------------------------------------------------------------
   External corpus linking (CText / ctext.org)

   Three tiers, tried in order, since a UD treebank's sent_id doesn't map
   onto CText's own identifiers automatically:
     1. A curated `ctext_urn` on the example row — most precise, resolved
        via CText's documented getlink API (works for chapter- or
        passage-level URNs alike).
     2. A `chapter` name (the traditional 篇 division) looked up in
        CHAPTER_SLUG_MAP — this works because UD_Classical_Chinese-Kyoto's
        own file organization already uses these same traditional chapter
        names (學而篇第一, 梁惠王上, etc.), which are the same names CText
        uses for its chapter URL slugs — both inherit the division from the
        canonical text tradition rather than inventing their own scheme.
        This is a best-effort seed list — extend it for chapters you use.
     3. A CText full-text search using the sentence text itself, as a
        fallback that always produces *something* clickable even with zero
        curated metadata.
   ------------------------------------------------------------------------- */
const CHAPTER_SLUG_MAP = {
  '論語': { work: 'analects', chapters: {
    '學而': 'xue-er', '為政': 'wei-zheng', '八佾': 'ba-yi', '里仁': 'li-ren',
    '公冶長': 'gong-ye-chang', '雍也': 'yong-ye', '述而': 'shu-er', '泰伯': 'tai-bo',
    '子罕': 'zi-han', '鄉黨': 'xiang-dang', '先進': 'xian-jin', '顏淵': 'yan-yuan',
    '子路': 'zi-lu', '憲問': 'xian-wen', '衛靈公': 'wei-ling-gong', '季氏': 'ji-shi',
    '陽貨': 'yang-huo', '微子': 'wei-zi', '子張': 'zi-zhang', '堯曰': 'yao-yue',
  }},
  '孟子': { work: 'mengzi', chapters: {
    '梁惠王上': 'liang-hui-wang-i', '梁惠王下': 'liang-hui-wang-ii',
    '公孫丑上': 'gong-sun-chou-i', '公孫丑下': 'gong-sun-chou-ii',
    '滕文公上': 'teng-wen-gong-i', '滕文公下': 'teng-wen-gong-ii',
    '離婁上': 'li-lou-i', '離婁下': 'li-lou-ii',
    '萬章上': 'wan-zhang-i', '萬章下': 'wan-zhang-ii',
    '告子上': 'gaozi-i', '告子下': 'gaozi-ii',
    '盡心上': 'jin-xin-i', '盡心下': 'jin-xin-ii',
  }},
  // extend as needed for 禮記, 楚辭, 戰國策, etc. — slugs above for those
  // works are less certain and worth verifying against ctext.org directly
};

function resolveExternalLink(ex) {
  if (ex.ctextUrn) {
    return {
      url: `https://api.ctext.org/getlink?urn=${encodeURIComponent(ex.ctextUrn)}&redirect=1`,
      label: 'View on CText →', tier: 'precise'
    };
  }
  if (ex.work && ex.chapter && CHAPTER_SLUG_MAP[ex.work] && CHAPTER_SLUG_MAP[ex.work].chapters[ex.chapter]) {
    const workSlug = CHAPTER_SLUG_MAP[ex.work].work;
    const chapterSlug = CHAPTER_SLUG_MAP[ex.work].chapters[ex.chapter];
    return {
      url: `https://api.ctext.org/getlink?urn=${encodeURIComponent('ctp:'+workSlug+'/'+chapterSlug)}&redirect=1`,
      label: 'View chapter on CText →', tier: 'chapter'
    };
  }
  // a full-text search on ctext.org only makes sense for Chinese text
  if (ex.text && ex.text.trim() && /[\u3400-\u9fff\uf900-\ufaff]/.test(ex.text)) {
    return {
      url: `https://ctext.org/pre-qin-and-han?searchu=${encodeURIComponent(ex.text.trim())}`,
      label: 'Search CText for this passage →', tier: 'fallback'
    };
  }
  return null;
}

/* =========================================================================
   CSV PARSING → INDICES
   ========================================================================= */
// Forgiving about what spreadsheet programs produce: strips the invisible
// byte-order mark Excel adds, copes with ; or tab separators (PapaParse
// detects the delimiter), and ignores capitalisation/spaces in column names.
function parseCSVText(text) {
  const clean = String(text).replace(/^﻿/, '').trim();
  const parsed = Papa.parse(clean, {
    header: true, skipEmptyLines: true, dynamicTyping: false,
    transformHeader: h => String(h).replace(/^﻿/, '').trim().toLowerCase()
  });
  if (parsed.errors && parsed.errors.length) {
    console.warn('CSV parse warnings:', parsed.errors);
  }
  return parsed.data;
}

// Decide what a table is, from its column names alone
function detectKind(rows) {
  if (!rows.length) return null;
  const cols = new Set(Object.keys(rows[0]));
  if (!cols.has('word1') || !cols.has('word2')) return null;
  const hasScore = cols.has('sym_score') || cols.has('asym_score') || cols.has('asym_score_2');
  if (cols.has('text') && !hasScore) return 'examples';
  return 'pairs';
}

// Builds App.examples: "word1|word2" (lowercased) -> array of example rows.
// A separate joined table, not columns on the main pairs CSV, since a pair
// can have many examples — same relational shape as CLDF's ExampleTable.
function parseExamplesCSV(rawRows) {
  const map = new Map();
  rawRows.forEach(r => {
    const word1 = (r.word1 || '').trim();
    const word2 = (r.word2 || '').trim();
    const text = (r.text || '').trim();
    if (!word1 || !word2 || !text) return;
    const key = word1.toLowerCase() + '|' + word2.toLowerCase();
    const num = v => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
    const ex = {
      text,
      translation: (r.translation || '').trim(),
      udSentId: (r.ud_sent_id || '').trim(),
      work: (r.work || '').trim(),
      chapter: (r.chapter || '').trim(),
      ctextUrn: (r.ctext_urn || '').trim(),
      sourceLabel: (r.source_label || '').trim(),
      // substrings within `translation` corresponding to word1/word2, for
      // highlighting correspondence in the translation
      trans1: (r.trans1 || '').trim(),
      trans2: (r.trans2 || '').trim(),
      // optional precise character offsets into `text`, overriding the
      // auto-located (closest-occurrence) span when present
      w1Start: num(r.w1_start), w1End: num(r.w1_end),
      w2Start: num(r.w2_start), w2End: num(r.w2_end),
    };
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ex);
  });
  return map;
}

function buildIndices(rawRows) {
  const rows = [];
  const slot1 = new Map();
  const slot2 = new Map();
  const attrSchema = { w1:{}, w2:{}, pair:{} };

  const ensureWord = (map, word, slotName) => {
    if (!map.has(word)) {
      map.set(word, { id: (slotName+'::'+word), label: word, slot: slotName, attrs: {}, edges: [] });
    }
    return map.get(word);
  };

  const addAttr = (schemaScope, type, value) => {
    if (!attrSchema[schemaScope][type]) attrSchema[schemaScope][type] = new Set();
    attrSchema[schemaScope][type].add(value);
  };

  rawRows.forEach((r, idx) => {
    const word1 = (r.word1 || '').trim();
    const word2 = (r.word2 || '').trim();
    if (!word1 || !word2) return;
    const sym = parseFloat(r.sym_score);
    const asym = parseFloat(r.asym_score);
    const asym2 = parseFloat(r.asym_score_2);

    const rowAttrs = { w1:{}, w2:{}, pair:{} };
    Object.keys(r).forEach(col => {
      if (col.startsWith('attr_pair_')) {
        const type = col.slice('attr_pair_'.length);
        const val = (r[col]||'').trim();
        if (val) { rowAttrs.pair[type] = val; addAttr('pair', type, val); }
      } else if (col.startsWith('attr_w1_')) {
        const type = col.slice('attr_w1_'.length);
        const val = (r[col]||'').trim();
        if (val) { rowAttrs.w1[type] = val; addAttr('w1', type, val); }
      } else if (col.startsWith('attr_w2_')) {
        const type = col.slice('attr_w2_'.length);
        const val = (r[col]||'').trim();
        if (val) { rowAttrs.w2[type] = val; addAttr('w2', type, val); }
      }
    });

    rows.push({ word1, word2, sym: isNaN(sym)?null:sym, asym: isNaN(asym)?null:asym, asym2: isNaN(asym2)?null:asym2, attrs: rowAttrs });

    const n1 = ensureWord(slot1, word1, 'slot1');
    const n2 = ensureWord(slot2, word2, 'slot2');
    n1.edges.push(idx);
    n2.edges.push(idx);
    Object.entries(rowAttrs.w1).forEach(([t,v]) => { (n1.attrs[t] ||= new Set()).add(v); });
    Object.entries(rowAttrs.w2).forEach(([t,v]) => { (n2.attrs[t] ||= new Set()).add(v); });
  });

  return { rows, slot1, slot2, attrSchema };
}

/* =========================================================================
   FILTERING
   ========================================================================= */
function wordPassesFilters(node, scope) {
  const filt = App.filters[scope];
  for (const type of Object.keys(filt)) {
    const selected = filt[type];
    if (!selected || selected.size === 0) continue;
    const vals = node.attrs[type];
    if (!vals) return false;
    let hit = false;
    for (const v of vals) if (selected.has(v)) { hit = true; break; }
    if (!hit) return false; // AND across types
  }
  return true;
}

function pairPassesFilters(rowAttrsPair) {
  const filt = App.filters.pair;
  for (const type of Object.keys(filt)) {
    const selected = filt[type];
    if (!selected || selected.size === 0) continue;
    const val = rowAttrsPair[type];
    if (!val || !selected.has(val)) return false;
  }
  return true;
}

function edgePasses(rowIdx) {
  const row = App.rows[rowIdx];
  const n1 = App.slot1.get(row.word1);
  const n2 = App.slot2.get(row.word2);
  return wordPassesFilters(n1,'w1') && wordPassesFilters(n2,'w2') && pairPassesFilters(row.attrs.pair);
}

/* =========================================================================
   FILTER PANEL UI
   ========================================================================= */
function activeFilterCount() {
  let n = 0;
  ['w1','w2','pair'].forEach(sc => Object.values(App.filters[sc]).forEach(set => { if (set && set.size) n += set.size; }));
  return n;
}

function clearAllFilters() {
  App.filters = { w1:{}, w2:{}, pair:{} };
  refreshAll();
}

function renderFilterPanel() {
  const el = $('filter-panel');
  const scopes = [['w1', App.labels.slot1 + ' tags'], ['w2', App.labels.slot2 + ' tags'], ['pair', 'Pair tags']];
  let groups = '';
  scopes.forEach(([scope, label]) => {
    const types = Object.keys(App.attrSchema[scope]);
    if (!types.length) return;
    groups += `<div class="filter-group"><div class="filter-group-label">${escapeHtml(label)}</div>`;
    types.forEach(type => {
      const values = Array.from(App.attrSchema[scope][type]).sort();
      groups += `<div class="filter-type"><div class="filter-type-name">${escapeHtml(pretty(type))}</div><div class="filter-values">`;
      values.forEach(v => {
        const active = App.filters[scope][type] && App.filters[scope][type].has(v);
        groups += `<button type="button" class="chip ${active ? 'active' : ''}" aria-pressed="${active ? 'true' : 'false'}" data-scope="${scope}" data-type="${escapeAttr(type)}" data-value="${escapeAttr(v)}">${escapeHtml(v)}</button>`;
      });
      groups += `</div></div>`;
    });
    groups += `</div>`;
  });

  const n = activeFilterCount();
  const badge = $('filters-badge');
  badge.hidden = n === 0;
  badge.textContent = n;

  if (!groups) {
    el.innerHTML = '<p class="empty-note">This data has no tags to filter by. Tags are optional extra columns in the file (see Help).</p>';
    return;
  }
  el.innerHTML =
    `<p class="help-text" style="margin-top:0;">Choose tags to show only the matching words. Other words fade out.</p>`
    + (n ? `<button type="button" class="btn small" id="filters-clear" style="margin-bottom:16px;">Clear all filters</button>` : '')
    + groups
    + `<p class="help-text">Choosing several tags in the <em>same</em> row shows words that have <em>any</em> of them. Choosing tags in <em>different</em> rows shows only words that match <em>every</em> row.</p>`;

  const clear = $('filters-clear');
  if (clear) clear.addEventListener('click', clearAllFilters);

  el.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const { scope, type, value } = chip.dataset;
      if (!App.filters[scope][type]) App.filters[scope][type] = new Set();
      const set = App.filters[scope][type];
      if (set.has(value)) set.delete(value); else set.add(value);
      refreshAll();
    });
  });
}

/* =========================================================================
   WORD LISTS (left pane)
   ========================================================================= */
const WORD_TAG_CAP = 50;

function renderWordLists() {
  const q = App.wordQuery.trim().toLowerCase();
  const slotClass = { w1: 'slot1', w2: 'slot2' };

  const build = (map, scope) => {
    let words = Array.from(map.values()).sort((a, b) => b.edges.length - a.edges.length || a.label.localeCompare(b.label));
    if (q) words = words.filter(n => n.label.toLowerCase().includes(q));
    const expanded = App.wordListExpanded[scope] || !!q;
    const shown = expanded ? words : words.slice(0, WORD_TAG_CAP);
    const hiddenCount = words.length - shown.length;

    if (!words.length) return `<p class="empty-note">${q ? 'No match.' : '–'}</p>`;

    let html = shown.map(n => {
      const passes = wordPassesFilters(n, scope);
      const isFocal = App.focal && App.focal.id === n.id;
      const cls = ['word-tag', slotClass[scope]];
      if (!passes) cls.push('dimmed');
      if (isFocal) cls.push('focal');
      const partners = n.edges.length;
      return `<button type="button" class="${cls.join(' ')}" data-id="${escapeAttr(n.id)}" title="${partners} partner${partners === 1 ? '' : 's'}">`
        + `${escapeHtml(n.label)}<span class="deg">${partners}</span></button>`;
    }).join('');

    if (hiddenCount > 0) {
      html += `<button type="button" class="word-more-btn" data-scope="${scope}">Show ${hiddenCount} more</button>`;
    } else if (App.wordListExpanded[scope] && words.length > WORD_TAG_CAP && !q) {
      html += `<button type="button" class="word-more-btn" data-scope="${scope}" data-collapse="1">Show fewer</button>`;
    }
    return html;
  };

  $('slot1-title').textContent = App.labels.slot1;
  $('slot2-title').textContent = App.labels.slot2;
  $('slot1-count').textContent = App.slot1.size || '';
  $('slot2-count').textContent = App.slot2.size || '';
  $('slot1-list').innerHTML = App.slot1.size ? build(App.slot1, 'w1') : '<p class="empty-note">–</p>';
  $('slot2-list').innerHTML = App.slot2.size ? build(App.slot2, 'w2') : '<p class="empty-note">–</p>';

  document.querySelectorAll('.word-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const id = tag.dataset.id;
      focusNode(id, id.split('::')[0]);
    });
  });
  document.querySelectorAll('.word-more-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      App.wordListExpanded[btn.dataset.scope] = !btn.dataset.collapse;
      renderWordLists();
    });
  });
}

// "Find a word": narrows the two lists as you type; Enter opens the best match
function bestSearchMatch() {
  const q = App.wordQuery.trim().toLowerCase();
  if (!q) return null;
  const all = [...App.slot1.values(), ...App.slot2.values()];
  const exact = all.find(n => n.label.toLowerCase() === q);
  if (exact) return exact;
  const matches = all.filter(n => n.label.toLowerCase().includes(q));
  matches.sort((a, b) => b.edges.length - a.edges.length);
  return matches[0] || null;
}

/* =========================================================================
   GRAPH RENDERING
   ========================================================================= */
// One-way pull of a pair, seen from the word in focus. 'asym_score' is the pull of the first word
// on the second; the optional 'asym_score_2' is the pull of the second word on the first (when it is
// missing, 'asym_score' is used for both directions).
function pullOf(row, focalScope) {
  if (focalScope === 'slot2' && row.asym2 != null) return row.asym2;
  return row.asym;
}

// Fonts and colours come from the stylesheet (so custom.css / the site settings control them)
const cssVar = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
// Cytoscape silently ignores a font list that contains single quotes or non-ASCII family names,
// so convert 'Noto Sans TC' to "Noto Sans TC" and keep only the entries it accepts.
function cyFontFamily(stack) {
  const ok = /^[\w\- "]+$/;
  const parts = String(stack).split(',').map(s => s.trim().replace(/'/g, '"')).filter(s => s && ok.test(s));
  return parts.length ? parts.join(', ') : 'Helvetica, Arial, sans-serif';
}
const GRAPH_FONT = cyFontFamily(cssVar('--word-font', 'Helvetica, Arial, sans-serif'));
const COL_BLUE = cssVar('--c1', '#1a64a8'), COL_ORANGE = cssVar('--c2', '#b4500a');

// Label size when zooming. Nodes grow in step with the zoom, but labels grow only as the
// zoom ^ LABEL_ZOOM_POWER (0 = labels never grow, 1 = labels scale with everything else), so
// zooming in pulls crowded nodes apart faster than their words swell. 'Zoom' is measured
// relative to the whole-picture view, so zooming out never shrinks the words.
const LABEL_ZOOM_POWER = 0.35;
const LABEL_BASE = { normal: 15, focal: 19, exterior: 12 };
function labelScale() {
  if (!App.cy) return 1;
  const rel = App.cy.zoom() / (App.refZoom || App.cy.zoom() || 1);
  return rel > 1 ? Math.pow(rel, LABEL_ZOOM_POWER - 1) : 1;
}
let labelRaf = 0;
function refreshLabelSize() {
  if (labelRaf) return;
  labelRaf = requestAnimationFrame(() => { labelRaf = 0; if (App.cy) App.cy.style().update(); });
}
function markFitZoom() { if (App.cy) { App.refZoom = App.cy.zoom(); refreshLabelSize(); } }

function initCy() {
  App.cy = cytoscape({
    container: $('cy'),
    elements: [],
    style: [
      { selector: 'node', style: {
          'label': 'data(label)',
          'font-family': GRAPH_FONT,
          'font-weight': '500',
          'font-size': () => LABEL_BASE.normal * labelScale(),
          'color': '#1c2330',
          'text-valign': 'bottom',
          'text-margin-y': 6,
          'background-color': COL_BLUE,
          'width': 'data(size)',
          'height': 'data(size)',
          'border-width': 1.5,
          'border-color': '#ffffff',
      }},
      // first group: circles; second group: rounded squares (shape as well as colour, so it reads in greyscale)
      { selector: 'node[slot="slot1"]', style: { 'background-color': COL_BLUE, shape: 'ellipse' } },
      { selector: 'node[slot="slot2"]', style: { 'background-color': COL_ORANGE, shape: 'round-rectangle' } },
      { selector: 'node.focal', style: { 'border-width': 3, 'border-color': '#1c2330', 'font-size': () => LABEL_BASE.focal * labelScale(), 'font-weight': '700' } },
      { selector: 'node.exterior', style: { 'background-color': '#aab4c0', 'font-size': () => LABEL_BASE.exterior * labelScale(), 'opacity': 0.75 } },
      { selector: 'node.filtered-out', style: { 'opacity': 0.15 } },
      { selector: 'edge', style: {
          'width': 'data(width)',
          'line-color': '#9aa5b4',
          'target-arrow-shape': 'none',
          'curve-style': 'bezier',
          'opacity': 0.75,
      }},
      { selector: 'edge:active, edge.hovered', style: { 'line-color': '#1c2330', 'opacity': 1 } },
    ],
    layout: { name: 'preset' },
    wheelSensitivity: 0.25,
  });

  App.cy.on('zoom', refreshLabelSize);

  App.cy.on('tap', 'node', evt => {
    const n = evt.target;
    focusNode(n.id(), n.data('slot'));
  });

  App.cy.on('tap', 'edge', evt => {
    const e = evt.target;
    openPairDetail(e.data('word1'), e.data('word2'));
  });

  App.cy.on('mouseover', 'edge', evt => {
    evt.target.addClass('hovered');
    $('cy').style.cursor = 'pointer';
  });
  App.cy.on('mouseout', 'edge', evt => {
    evt.target.removeClass('hovered');
    $('cy').style.cursor = 'default';
  });
  App.cy.on('mouseover', 'node', () => { $('cy').style.cursor = 'pointer'; });
  App.cy.on('mouseout', 'node', () => { $('cy').style.cursor = 'default'; });

  // clicking empty canvas (not a node/edge) returns to the overview
  App.cy.on('tap', evt => {
    if (evt.target === App.cy) clearFocus();
  });
}

function renderDetailEmpty() {
  $('detail-panel').innerHTML = '<p class="empty-note" style="font-size:15px;">Click a word in the picture, or in the lists on the left, to see its partners here.</p>';
}

function clearFocus() {
  if (!App.focal) return;
  App.focal = null;
  renderGraph();
  renderWordLists();
  renderDetailEmpty();
}

function rankScale(values, idx, minR, maxR) {
  // values: array of numeric scores, higher = stronger = should be closer.
  // returns radius for the item at position idx after sorting desc.
  const n = values.length;
  if (n <= 1) return minR;
  const sorted = values.slice().sort((a,b)=>b-a);
  const rank = sorted.indexOf(values[idx]); // approx; fine for prototype
  return minR + (rank/(n-1)) * (maxR-minR);
}

function rawScale(values, idx, minR, maxR) {
  const n = values.length;
  if (n <= 1) return minR;
  const max = Math.max(...values), min = Math.min(...values);
  if (max === min) return (minR+maxR)/2;
  const v = values[idx];
  // higher score = stronger = closer, so invert
  const t = (v - min) / (max - min); // 0..1, 1 = strongest
  return maxR - t * (maxR - minR);
}

function logScale(values, idx, minR, maxR) {
  const n = values.length;
  if (n <= 1) return minR;
  // shift so all values are positive before taking logs (association measures
  // like PMI can be negative), then min-max normalize the logged values
  const rawMin = Math.min(...values);
  const shift = rawMin <= 0 ? (-rawMin + 1) : 0;
  const logged = values.map(v => Math.log(v + shift + 1e-9));
  const lmax = Math.max(...logged), lmin = Math.min(...logged);
  if (lmax === lmin) return (minR+maxR)/2;
  const t = (logged[idx] - lmin) / (lmax - lmin); // 0..1, 1 = strongest
  return maxR - t * (maxR - minR);
}

// Nudges overlapping points apart with iterative pairwise repulsion, then
// clamps each point's total displacement from its original spot so the
// jitter stays a small local correction rather than a full relayout — the
// radius/angle a point was given (association strength, SVD position) still
// dominates; this only breaks exact/near overlaps between labels.
// items: array of {id, x, y, r, fixed}. Mutates x/y in place.
function declutterPositions(items, opts) {
  const { iterations = 50, padding = 6, maxDisplacement = 30 } = opts || {};
  if (items.length < 2) return items;
  items.forEach(it => { it.ox = it.x; it.oy = it.y; });
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r + padding;
        if (dist < minDist) {
          moved = true;
          if (dist < 1e-6) {
            // exactly coincident: nudge apart along a deterministic pseudo-random
            // direction so they don't stay perfectly stacked
            const ang = ((i * 97 + j * 53) % 360) * Math.PI / 180;
            dx = Math.cos(ang); dy = Math.sin(ang); dist = 1e-6;
          }
          const overlap = minDist - dist;
          const ux = dx / dist, uy = dy / dist;
          const aFixed = !!a.fixed, bFixed = !!b.fixed;
          const moveA = aFixed ? 0 : (bFixed ? overlap : overlap / 2);
          const moveB = bFixed ? 0 : (aFixed ? overlap : overlap / 2);
          if (!aFixed) { a.x -= ux * moveA; a.y -= uy * moveA; }
          if (!bFixed) { b.x += ux * moveB; b.y += uy * moveB; }
        }
      }
    }
    if (!moved) break;
  }
  items.forEach(it => {
    if (it.fixed) return;
    const ddx = it.x - it.ox, ddy = it.y - it.oy;
    const d = Math.hypot(ddx, ddy);
    if (d > maxDisplacement) {
      const scale = maxDisplacement / d;
      it.x = it.ox + ddx * scale;
      it.y = it.oy + ddy * scale;
    }
  });
  return items;
}

/* -------------------------------------------------------------------------
   Rank-2 truncated SVD via power iteration (with deflation), used to lay
   out the default overview: both slots share one latent space computed
   from the slot1 x slot2 symmetric-association matrix, so that words with
   similar association patterns — and directly strongly-associated pairs —
   end up close together. Small/self-contained since no linear-algebra lib
   is loaded; adequate for exploratory dataset sizes.
   ------------------------------------------------------------------------- */
function seededRandom(seed) {
  // mulberry32 — deterministic so re-loading the same CSV gives the same layout
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function matVec(A, v, m, n) {
  const out = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0;
    const row = A[i];
    for (let j = 0; j < n; j++) s += row[j] * v[j];
    out[i] = s;
  }
  return out;
}
function matVecT(A, u, m, n) {
  const out = new Array(n).fill(0);
  for (let i = 0; i < m; i++) {
    const row = A[i], ui = u[i];
    if (ui === 0) continue;
    for (let j = 0; j < n; j++) out[j] += row[j] * ui;
  }
  return out;
}
function vecNorm(v) { return Math.sqrt(v.reduce((s,x)=>s+x*x,0)); }
function normalizeInPlace(v) {
  const nrm = vecNorm(v);
  if (nrm > 1e-12) for (let i=0;i<v.length;i++) v[i] /= nrm;
  return v;
}

function powerIterationSVD1(A, m, n, rng, iters) {
  let v = Array.from({length:n}, () => rng()*2-1);
  normalizeInPlace(v);
  let u = new Array(m).fill(0);
  for (let it = 0; it < iters; it++) {
    u = matVec(A, v, m, n);
    normalizeInPlace(u);
    v = matVecT(A, u, m, n);
    normalizeInPlace(v);
  }
  const Av = matVec(A, v, m, n);
  const sigma = vecNorm(Av);
  const uFinal = sigma > 1e-9 ? Av.map(x => x/sigma) : u;
  return { u: uFinal, sigma, v };
}

function truncatedSVD(A, m, n, k, iters) {
  const Acur = A.map(row => row.slice());
  const Us = [], Ss = [], Vs = [];
  for (let c = 0; c < k; c++) {
    const rng = seededRandom(42 + c);
    const { u, sigma, v } = powerIterationSVD1(Acur, m, n, rng, iters);
    Us.push(u); Ss.push(sigma); Vs.push(v);
    for (let i = 0; i < m; i++) {
      const ui = u[i];
      for (let j = 0; j < n; j++) Acur[i][j] -= sigma * ui * v[j];
    }
  }
  return { Us, Ss, Vs };
}

// Fallback for tiny/degenerate datasets: evenly spaced on a circle.
function circleFallbackPositions(slot1Words, slot2Words) {
  const positions = new Map();
  const all = [...slot1Words.map(w=>['slot1',w]), ...slot2Words.map(w=>['slot2',w])];
  const R = 260;
  all.forEach(([scope, w], i) => {
    const angle = (i / Math.max(all.length,1)) * Math.PI * 2;
    positions.set(scope+'::'+w, { x: Math.cos(angle)*R, y: Math.sin(angle)*R });
  });
  return positions;
}

function computeOverviewPositions() {
  const slot1Words = Array.from(App.slot1.keys());
  const slot2Words = Array.from(App.slot2.keys());
  const m = slot1Words.length, n = slot2Words.length;
  if (m < 2 || n < 2) return circleFallbackPositions(slot1Words, slot2Words);

  try {
    const idx1 = new Map(slot1Words.map((w,i)=>[w,i]));
    const idx2 = new Map(slot2Words.map((w,i)=>[w,i]));
    const M = Array.from({length:m}, () => new Array(n).fill(0));
    App.rows.forEach(row => {
      if (row.sym == null) return;
      const i = idx1.get(row.word1), j = idx2.get(row.word2);
      if (i !== undefined && j !== undefined) M[i][j] = row.sym;
    });

    const { Us, Ss, Vs } = truncatedSVD(M, m, n, 2, 150);
    if (!isFinite(Ss[0]) || Ss[0] < 1e-9) return circleFallbackPositions(slot1Words, slot2Words);
    const s0 = Math.sqrt(Ss[0]), s1 = Math.sqrt(Ss[1] || 0);

    const raw1 = slot1Words.map((w,i) => [Us[0][i]*s0, (Us[1]?Us[1][i]:0)*s1]);
    const raw2 = slot2Words.map((w,j) => [Vs[0][j]*s0, (Vs[1]?Vs[1][j]:0)*s1]);
    const allPts = [...raw1, ...raw2];
    const maxAbs = Math.max(1e-6, ...allPts.map(p => Math.max(Math.abs(p[0]), Math.abs(p[1]))));
    const targetRadius = 210;
    const scale = targetRadius / maxAbs;

    const positions = new Map();
    slot1Words.forEach((w,i) => positions.set('slot1::'+w, { x: raw1[i][0]*scale, y: raw1[i][1]*scale }));
    slot2Words.forEach((w,j) => positions.set('slot2::'+w, { x: raw2[j][0]*scale, y: raw2[j][1]*scale }));
    return positions;
  } catch (err) {
    console.warn('SVD layout failed, falling back to circle layout:', err);
    return circleFallbackPositions(slot1Words, slot2Words);
  }
}

function focusNode(id, scope) {
  const map = scope === 'slot1' ? App.slot1 : App.slot2;
  const node = map.get(id.split('::').slice(1).join('::'));
  if (!node) return;
  App.focal = { id: node.id, slot: scope, word: node.label };
  renderGraph();
  renderWordLists();
  renderDetailPanel(node, scope);
}

// ---- target computation: pure functions returning {nodes: Map, edges: Map} ----

function computeOverviewTarget() {
  const nodes = new Map();
  const edges = new Map();
  if (!App.overviewPositions) App.overviewPositions = computeOverviewPositions();
  const s1 = Array.from(App.slot1.values());
  const s2 = Array.from(App.slot2.values());

  const items = [];
  s1.forEach(n => {
    const pos = App.overviewPositions.get(n.id) || { x: 0, y: 0 };
    const size = 14 + Math.min(n.edges.length,10)*2;
    items.push({ id: n.id, x: pos.x, y: pos.y, r: size/2, node: n, slot: 'slot1', size });
  });
  s2.forEach(n => {
    const pos = App.overviewPositions.get(n.id) || { x: 0, y: 0 };
    const size = 14 + Math.min(n.edges.length,10)*2;
    items.push({ id: n.id, x: pos.x, y: pos.y, r: size/2, node: n, slot: 'slot2', size });
  });
  declutterPositions(items, { padding: 8, maxDisplacement: 35 });

  items.forEach(it => {
    const passes = wordPassesFilters(it.node, it.slot === 'slot1' ? 'w1' : 'w2');
    nodes.set(it.id, {
      data: { id: it.id, label: it.node.label, slot: it.slot, size: it.size },
      position: { x: it.x, y: it.y },
      classes: passes ? '' : 'filtered-out'
    });
  });
  return { nodes, edges };
}

// Angle (in radians) for a word's position, derived from where it sits on the
// first two SVD/PCA axes computed for the overview layout — so a word's
// angular placement around the ego node is consistent with its position in
// the broader semantic/associative space, not an arbitrary rank ordering.
// Falls back to a supplied rank-based angle if the SVD position is missing
// or degenerate (e.g. an isolated component that collapsed near the origin).
function svdAngleFor(id, fallbackAngle) {
  if (!App.overviewPositions) App.overviewPositions = computeOverviewPositions();
  const pos = App.overviewPositions.get(id);
  if (!pos) return fallbackAngle;
  const mag = Math.hypot(pos.x, pos.y);
  if (mag < 1e-6) return fallbackAngle; // degenerate: avoid stacking multiple nodes at angle 0
  return Math.atan2(pos.y, pos.x);
}

function angularDist(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

// deterministic 32-bit hash of a string, used to seed the angle-spreading
// RNG so the same focal word (+ metric) always jitters the same way
function hashStringToSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// If `angle` lands within `threshold` radians of an angle already used in
// this ring, nudge it apart with a small offset drawn from `rng` (a seeded
// generator — see seededRandom) — otherwise several collocates with
// near-identical SVD angles would sit almost exactly along the same ray
// from the ego node and read visually as one straight line, even though
// their radii differ. Seeded so the same view reproduces the same layout
// on re-render rather than reshuffling every time.
function spreadCloseAngle(angle, usedAngles, rng, threshold = 0.14, jitterRange = 0.5) {
  const tooClose = usedAngles.some(a => angularDist(a, angle) < threshold);
  const finalAngle = tooClose ? angle + (rng() - 0.5) * jitterRange : angle;
  usedAngles.push(finalAngle);
  return finalAngle;
}

function radiusForScale(values, idx, minR, maxR) {
  if (App.scale === 'rank') {
    const n = values.length;
    if (n <= 1) return minR;
    const sorted = values.slice().sort((a,b)=>b-a);
    const rank = sorted.indexOf(values[idx]);
    return minR + (rank/(n-1)) * (maxR-minR);
  }
  if (App.scale === 'log') return logScale(values, idx, minR, maxR);
  return rawScale(values, idx, minR, maxR);
}

function computeFocusTarget() {
  const nodes = new Map();
  const edges = new Map();
  const focalScope = App.focal.slot;
  const focalMap = focalScope === 'slot1' ? App.slot1 : App.slot2;
  const otherMap = focalScope === 'slot1' ? App.slot2 : App.slot1;
  const focalNode = focalMap.get(App.focal.word);

  // seeded so this view's angle-spreading jitter is reproducible on
  // re-render, rather than reshuffling every time — order of collocates
  // depends on which measure they're sorted by, so that's part of the seed
  const angleRng = seededRandom(hashStringToSeed(focalNode.id + '::' + App.metric));

  const validRows = focalNode.edges.filter(edgePasses);
  const scores = validRows.map(ri => {
    const row = App.rows[ri];
    const v = App.metric === 'asym' ? pullOf(row, focalScope) : row.sym;
    return v == null ? 0 : v;
  });

  const minR = 70, maxR = 250;
  const n = validRows.length;
  const scored = validRows.map((ri, i) => ({ ri, score: scores[i], origIdx: i }));
  const orderedDesc = scored.slice().sort((a,b) => b.score - a.score);

  const displayedOtherIds = new Set();

  // collocate ring: compute raw radius/angle positions first, then declutter
  // (focal stays fixed as an obstacle the others get pushed away from)
  const collocateItems = [{ id: focalNode.id, x: 0, y: 0, r: 17, fixed: true }];
  const collocateMeta = new Map(); // id -> { otherNode, ri, score }
  const usedCollocateAngles = [];

  orderedDesc.forEach((item, order) => {
    const row = App.rows[item.ri];
    const otherWord = focalScope === 'slot1' ? row.word2 : row.word1;
    const otherNode = otherMap.get(otherWord);
    const radius = radiusForScale(scores, item.origIdx, minR, maxR);
    const rankAngle = (order / Math.max(n,1)) * Math.PI * 2 - Math.PI/2; // fallback only
    let angle = svdAngleFor(otherNode.id, rankAngle);
    angle = spreadCloseAngle(angle, usedCollocateAngles, angleRng);
    collocateItems.push({ id: otherNode.id, x: Math.cos(angle)*radius, y: Math.sin(angle)*radius, r: 12 });
    collocateMeta.set(otherNode.id, { otherNode, ri: item.ri, score: item.score });
    displayedOtherIds.add(otherNode.id);
  });

  declutterPositions(collocateItems, { padding: 10, maxDisplacement: 26 });

  collocateItems.forEach(it => {
    if (it.fixed) {
      nodes.set(it.id, {
        data: { id: focalNode.id, label: focalNode.label, slot: focalScope, size: 30 },
        position: { x: it.x, y: it.y },
        classes: 'focal'
      });
      return;
    }
    const meta = collocateMeta.get(it.id);
    nodes.set(it.id, {
      data: { id: meta.otherNode.id, label: meta.otherNode.label, slot: meta.otherNode.slot, size: 20 },
      position: { x: it.x, y: it.y },
      classes: ''
    });
    edges.set('e'+meta.ri, {
      data: {
        id: 'e'+meta.ri, source: focalNode.id, target: meta.otherNode.id,
        width: 1 + (meta.score||0) * (App.metric==='asym'? 6 : 0.4),
        word1: App.rows[meta.ri].word1, word2: App.rows[meta.ri].word2
      }
    });
  });

  // exterior ring: other words in the SAME slot as focal, restricted to those
  // that share at least one currently-displayed collocate with the focal word
  // (i.e. compete for/overlap with focal's neighborhood) — words with no
  // connection at all to the displayed collocates are omitted entirely.
  const sameSlotConnected = Array.from(focalMap.values()).filter(w => {
    if (w.id === focalNode.id) return false;
    return w.edges.some(ri => {
      const row = App.rows[ri];
      const otherWord = focalScope === 'slot1' ? row.word2 : row.word1;
      const otherId = (focalScope === 'slot1' ? 'slot2::' : 'slot1::') + otherWord;
      return displayedOtherIds.has(otherId);
    });
  });

  const extR = maxR + 70;
  const usedExteriorAngles = [];
  const exteriorItems = sameSlotConnected.map((w, i) => {
    const rankAngle = (i / Math.max(sameSlotConnected.length,1)) * Math.PI * 2 - Math.PI/2; // fallback only
    let angle = svdAngleFor(w.id, rankAngle);
    angle = spreadCloseAngle(angle, usedExteriorAngles, angleRng);
    return { id: w.id, x: Math.cos(angle)*extR, y: Math.sin(angle)*extR, r: 7, node: w };
  });
  declutterPositions(exteriorItems, { padding: 8, maxDisplacement: 22 });

  exteriorItems.forEach(it => {
    const passes = wordPassesFilters(it.node, focalScope==='slot1'?'w1':'w2');
    nodes.set(it.id, {
      data: { id: it.id, label: it.node.label, slot: it.node.slot, size: 10 },
      position: { x: it.x, y: it.y },
      classes: 'exterior' + (passes ? '' : ' filtered-out')
    });
  });

  return { nodes, edges };
}

// ---- diffing renderer: animates existing nodes to new positions, fades in/out
//      new/removed nodes and edges, subject to the animation toggle + threshold ----

function applyGraph(target, animateRequested) {
  const cy = App.cy;
  const totalNodes = target.nodes.size;
  App.lastNodeCount = totalNodes;
  const doAnimate = animateRequested && App.animationEnabled && totalNodes <= App.animationThreshold;
  updateAnimStatus();

  const wanted = new Set(target.nodes.keys());

  // edges: always fully replaced each render; fade if animating
  if (doAnimate && cy.edges().length) {
    cy.edges().stop(true, true).animate({ style: { opacity: 0 } }, { duration: 200 });
    setTimeout(() => cy.edges().remove(), 210);
  } else {
    cy.edges().remove();
  }

  // remove nodes no longer present in target
  cy.nodes().forEach(n => {
    if (!wanted.has(n.id())) {
      if (doAnimate) {
        n.stop(true, true);
        n.animate({ style: { opacity: 0 } }, { duration: 300, complete: () => n.remove() });
      } else {
        n.remove();
      }
    }
  });

  // add or reposition nodes
  target.nodes.forEach((spec, id) => {
    const n = cy.getElementById(id);
    if (n && n.nonempty()) {
      n.data(spec.data);
      n.classes(spec.classes || '');
      if (doAnimate) {
        n.stop(true, true);
        n.animate({ position: spec.position }, { duration: 450, easing: 'ease-in-out-cubic' });
      } else {
        n.position(spec.position);
      }
    } else {
      const added = cy.add({ data: spec.data, position: spec.position, classes: spec.classes || '' });
      if (doAnimate) {
        added.style('opacity', 0);
        added.animate({ style: { opacity: 1 } }, { duration: 450 });
      }
    }
  });

  const addEdges = () => {
    target.edges.forEach((spec) => {
      const added = cy.add({ data: spec.data });
      if (doAnimate) {
        added.style('opacity', 0);
        added.animate({ style: { opacity: 0.8 } }, { duration: 300 });
      }
    });
  };
  if (doAnimate) setTimeout(addEdges, 220); else addEdges();

  const doFit = () => {
    if (doAnimate) {
      cy.animate({ fit: { eles: cy.elements(), padding: 50 } }, { duration: 300, complete: markFitZoom });
    } else {
      cy.fit(undefined, 50);
      markFitZoom();
    }
  };
  setTimeout(doFit, doAnimate ? 480 : 0);
}

function updateAnimStatus() {
  const el = document.getElementById('animate-status');
  if (!el) return;
  const count = App.lastNodeCount || 0;
  const thresh = App.animationThreshold;
  if (!App.animationEnabled) {
    el.textContent = 'Animation is off.';
  } else if (count > thresh) {
    el.textContent = `This view has ${count} words, more than ${thresh}, so animation is switched off for it.`;
  } else {
    el.textContent = count ? `This view has ${count} words, so it is animated.` : '';
  }
}

function renderLegend() {
  const items = [
    `<span class="item"><span class="swatch circle blue"></span>${escapeHtml(App.labels.slot1)}</span>`,
    `<span class="item"><span class="swatch square orange"></span>${escapeHtml(App.labels.slot2)}</span>`
  ];
  if (App.focal) {
    items.push(`<span class="item"><span class="swatch circle grey"></span>Other words of the same group that share partners</span>`);
  }
  $('legend').innerHTML = items.join('');
}

// The strip above the picture: says what you are looking at, and offers the way back
function renderGraphBar() {
  const msg = $('graph-bar-msg');
  const nFilters = activeFilterCount();
  let html;
  if (App.focal) {
    html = `Partners of <strong class="${App.focal.slot}">${escapeHtml(App.focal.word)}</strong>. `
      + `The closer a word sits to the centre, the stronger the link. Click a line to read example sentences.`;
  } else {
    html = `All ${App.slot1.size + App.slot2.size} words. Click any word to see its partners.`;
  }
  if (nFilters) html += ` <em>Filters are on, so some words are faded.</em>`;
  msg.innerHTML = html;
  $('graph-back').hidden = !App.focal;
  $('metric-wrap').hidden = !App.focal;
  const cf = $('graph-clear-filters');
  cf.hidden = nFilters === 0;
  cf.textContent = 'Clear filters (' + nFilters + ')';
}

function renderGraph(animate = true) {
  if (!App.slot1.size) {
    App.cy.elements().remove();
    return;
  }
  renderLegend();
  renderGraphBar();
  applyGraph(App.focal ? computeFocusTarget() : computeOverviewTarget(), animate);
}

/* =========================================================================
   DETAIL PANEL (right)
   ========================================================================= */
const COLLOCATE_SORT_DEFAULT_DIR = { word: 'asc', sym: 'desc', asym: 'desc' };

function renderDetailPanel(node, scope) {
  const el = $('detail-panel');
  const otherRows = node.edges.map(ri => App.rows[ri]);
  const label = node.label;
  const nPartners = node.edges.length;

  let attrsHtml = '';
  Object.entries(node.attrs).forEach(([type, set]) => {
    attrsHtml += `<div class="attr-row"><span class="k">${escapeHtml(pretty(type))}</span><span class="v">${escapeHtml(Array.from(set).join(', '))}</span></div>`;
  });

  // sort column defaults to whichever measure is currently used for distances,
  // until the person clicks a header; after that their choice persists
  const sortCol = App.collocateSort.col || App.metric;
  const sortDir = App.collocateSort.dir;
  const sorted = otherRows.slice().sort((a, b) => {
    if (sortCol === 'word') {
      const av = (scope === 'slot1' ? a.word2 : a.word1).toLowerCase();
      const bv = (scope === 'slot1' ? b.word2 : b.word1).toLowerCase();
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    const val = r => sortCol === 'asym' ? pullOf(r, scope) : r[sortCol];
    const av = val(a) == null ? -Infinity : val(a);
    const bv = val(b) == null ? -Infinity : val(b);
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  const arrowFor = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const rowsHtml = sorted.map(r => {
    const other = scope === 'slot1' ? r.word2 : r.word1;
    const w1 = scope === 'slot1' ? label : other;
    const w2 = scope === 'slot1' ? other : label;
    return `<tr data-word="${escapeAttr(other)}" data-scope="${scope === 'slot1' ? 'slot2' : 'slot1'}">
      <td class="word" title="Show this word's partners">${escapeHtml(other)}</td>
      <td class="num">${r.sym == null ? '–' : r.sym.toFixed(2)}</td>
      <td class="num">${pullOf(r, scope) == null ? '–' : pullOf(r, scope).toFixed(2)}</td>
      <td class="num"><button type="button" class="btn small pair-view-btn" data-w1="${escapeAttr(w1)}" data-w2="${escapeAttr(w2)}" title="Read example sentences for this pair">Examples</button></td>
    </tr>`;
  }).join('');

  const th = (col, text, tip, extra = '') =>
    `<th class="sortable ${extra}" data-col="${col}" tabindex="0" role="button" title="${escapeAttr(tip)}">${text}${arrowFor(col)}</th>`;

  el.innerHTML = `
    <p class="detail-word">${escapeHtml(label)}</p>
    <p class="detail-slot ${scope}"><span class="swatch ${scope === 'slot1' ? 'circle' : 'square'}"></span>${escapeHtml(labelFor(scope))} · ${nPartners} partner${nPartners === 1 ? '' : 's'}</p>
    ${attrsHtml ? `<div class="section-label">Tags</div>${attrsHtml}` : ''}
    <div class="section-label">Partners</div>
    <table class="collocate-table">
      <thead><tr>
        ${th('word', 'Word', 'Sort by word')}
        ${th('sym', 'Mutual', 'Mutual strength: how tightly the two words are tied together. Click to sort.', 'num')}
        ${th('asym', 'One-way', 'One-way pull of the word you are looking at on each partner. Click to sort.', 'num')}
        <th></th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p class="empty-note">Click a partner to move the picture to it. Click the column titles to re-order the list.</p>
  `;

  const sortBy = th => {
    const col = th.dataset.col;
    if (App.collocateSort.col === col) {
      App.collocateSort.dir = App.collocateSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      App.collocateSort.col = col;
      App.collocateSort.dir = COLLOCATE_SORT_DEFAULT_DIR[col];
    }
    renderDetailPanel(node, scope);
  };
  el.querySelectorAll('.collocate-table th.sortable').forEach(h => {
    h.addEventListener('click', () => sortBy(h));
    h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(h); } });
  });
  el.querySelectorAll('.collocate-table tr[data-word]').forEach(tr => {
    tr.querySelector('td.word').addEventListener('click', () => {
      const map = tr.dataset.scope === 'slot1' ? App.slot1 : App.slot2;
      const n = map.get(tr.dataset.word);
      if (n) focusNode(n.id, tr.dataset.scope);
    });
  });
  el.querySelectorAll('.pair-view-btn').forEach(btn => {
    btn.addEventListener('click', evt => {
      evt.stopPropagation();
      openPairDetail(btn.dataset.w1, btn.dataset.w2);
    });
  });
}

// Where does this pair rank among ALL of word1's collocates, and among ALL
// of word2's collocates, by a given metric? Gives the pair-level view
// context a word-level view alone can't: how central this specific
// combination is from both sides at once.
/* -------------------------------------------------------------------------
   Two-anchor KWIC

   A standard KWIC aligns on ONE search term with fixed-width left/right
   context. That doesn't work here: word1 and word2 can sit arbitrarily far
   apart (the whole reason for this view), so forcing a second alignment
   column would mean truncating the actual construction to make the
   columns line up — exactly the information you want to see. Instead:
   word1 and word2 keep a fixed color each (slot1/slot2) regardless of
   which one comes first in the sentence, so correspondence reads off
   color rather than position; the gap between them collapses if it's
   long, with a click to expand it back.
   ------------------------------------------------------------------------- */
const KWIC_GAP_COLLAPSE_THRESHOLD = 40; // characters
const KWIC_GAP_EDGE_CHARS = 14;         // chars kept visible at each edge when collapsed

// Finds word1's and word2's spans within `text`. Uses explicit w1Start/
// w1End/w2Start/w2End offsets when given (precise); otherwise auto-locates
// by finding the pair of occurrences closest together — since surface
// order isn't assumed fixed, and a word may recur in a sentence.
function locateSpans(ex, word1, word2) {
  const hasExplicit1 = ex.w1Start != null && ex.w1End != null;
  const hasExplicit2 = ex.w2Start != null && ex.w2End != null;
  let span1 = hasExplicit1 ? { start: ex.w1Start, end: ex.w1End } : null;
  let span2 = hasExplicit2 ? { start: ex.w2Start, end: ex.w2End } : null;
  if (span1 && span2) return { span1, span2 };

  const occurrences = (needle) => {
    const out = [];
    if (!needle) return out;
    let idx = ex.text.indexOf(needle);
    while (idx !== -1) { out.push(idx); idx = ex.text.indexOf(needle, idx + 1); }
    return out;
  };
  const occ1 = span1 ? [span1.start] : occurrences(word1);
  const occ2 = span2 ? [span2.start] : occurrences(word2);
  if (!occ1.length || !occ2.length) return { span1: span1 || null, span2: span2 || null };

  let best = null;
  occ1.forEach(i1 => occ2.forEach(i2 => {
    if (i1 === i2) return; // can't be the same character span
    const dist = Math.abs(i2 - i1);
    if (!best || dist < best.dist) best = { i1, i2, dist };
  }));
  if (!best) return { span1: null, span2: null };
  if (!span1) span1 = { start: best.i1, end: best.i1 + word1.length };
  if (!span2) span2 = { start: best.i2, end: best.i2 + word2.length };
  return { span1, span2 };
}

let kwicIdCounter = 0;

// Renders the original-text KWIC line: before | anchor | gap (collapsible) | anchor | after.
function renderKwicOriginal(ex, word1, word2) {
  const { span1, span2 } = locateSpans(ex, word1, word2);
  if (!span1 || !span2) {
    // couldn't locate one or both collocates in the text verbatim (e.g. an
    // inflected form) — degrade gracefully to plain text
    return `<div class="kwic-line">${escapeHtml(ex.text)}</div>`;
  }
  const [left, right] = span1.start <= span2.start
    ? [{ span: span1, cls: 'kwic-anchor1' }, { span: span2, cls: 'kwic-anchor2' }]
    : [{ span: span2, cls: 'kwic-anchor2' }, { span: span1, cls: 'kwic-anchor1' }];

  const before = ex.text.slice(0, left.span.start);
  const leftWord = ex.text.slice(left.span.start, left.span.end);
  const gap = ex.text.slice(left.span.end, right.span.start);
  const rightWord = ex.text.slice(right.span.start, right.span.end);
  const after = ex.text.slice(right.span.end);

  let gapHtml;
  if (gap.length > KWIC_GAP_COLLAPSE_THRESHOLD) {
    const id = 'kwicgap' + (kwicIdCounter++);
    const omitted = gap.length - KWIC_GAP_EDGE_CHARS * 2;
    gapHtml = `<span class="kwic-gap" id="${id}" data-full="${escapeAttr(gap)}" data-expanded="0">`
      + escapeHtml(gap.slice(0, KWIC_GAP_EDGE_CHARS))
      + `<span class="kwic-gap-toggle" title="Click to show the hidden text">⋯ ${omitted} more characters ⋯</span>`
      + escapeHtml(gap.slice(-KWIC_GAP_EDGE_CHARS))
      + `</span>`;
  } else {
    gapHtml = `<span class="kwic-gap-full">${escapeHtml(gap)}</span>`;
  }

  return `<div class="kwic-line">`
    + `<span class="kwic-before">${escapeHtml(before)}</span>`
    + `<span class="${left.cls}">${escapeHtml(leftWord)}</span>`
    + gapHtml
    + `<span class="${right.cls}">${escapeHtml(rightWord)}</span>`
    + `<span class="kwic-after">${escapeHtml(after)}</span>`
    + `</div>`;
}

// Renders the translation line with trans1/trans2 substrings highlighted —
// reusing the same mark.hit1/hit2 classes as the free-text highlighter, so
// "this color = this slot" holds across the whole app, including here.
function renderKwicTranslation(ex) {
  if (!ex.translation) return '';
  let marked = escapeHtml(ex.translation);
  const markSpan = (text, needle, cls) => {
    if (!needle) return text;
    const idx = text.indexOf(escapeHtml(needle));
    if (idx === -1) return text; // no match — degrade to plain, don't error
    const escNeedle = escapeHtml(needle);
    return text.slice(0, idx) + `<mark class="${cls}">` + escNeedle + `</mark>` + text.slice(idx + escNeedle.length);
  };
  marked = markSpan(marked, ex.trans1, 'hit1');
  marked = markSpan(marked, ex.trans2, 'hit2');
  return `<div class="pair-example-translation">${marked}</div>`;
}

function rankWithin(edgesIdx, targetRi, metric) {
  const scores = edgesIdx.map(ri => {
    const row = App.rows[ri];
    const v = row[metric];
    return v == null ? -Infinity : v;
  });
  const targetScore = App.rows[targetRi][metric];
  const better = scores.filter(s => s > (targetScore == null ? -Infinity : targetScore)).length;
  return { rank: better + 1, of: edgesIdx.length };
}


/* =========================================================================
   WORD PAIR DETAIL (dialog)
   ========================================================================= */
function openPairDetail(word1, word2) {
  const ri = App.rows.findIndex(r => r.word1 === word1 && r.word2 === word2);
  if (ri === -1) { console.warn('Pair not found:', word1, word2); return; }
  const row = App.rows[ri];
  const n1 = App.slot1.get(word1);
  const n2 = App.slot2.get(word2);

  const rankText = (metric, only) => {
    const a = rankWithin(n1.edges, ri, metric);
    const b = rankWithin(n2.edges, ri, metric);
    if (only === 1) return `Number ${a.rank} of ${a.of} among the partners of “${escapeHtml(word1)}”.`;
    if (only === 2) return `Number ${b.rank} of ${b.of} among the partners of “${escapeHtml(word2)}”.`;
    return `Number ${a.rank} of ${a.of} among the partners of “${escapeHtml(word1)}”, and number ${b.rank} of ${b.of} among the partners of “${escapeHtml(word2)}”.`;
  };

  let attrsHtml = '';
  Object.entries(row.attrs.pair || {}).forEach(([type, val]) => {
    attrsHtml += `<span class="pair-attr-chip">${escapeHtml(pretty(type))}: ${escapeHtml(val)}</span>`;
  });

  const key = word1.toLowerCase() + '|' + word2.toLowerCase();
  const examples = App.examples.get(key) || [];
  let examplesHtml;
  if (examples.length) {
    examplesHtml = examples.map(ex => {
      const link = resolveExternalLink(ex);
      const metaLeft = [ex.sourceLabel, ex.udSentId ? 'Sentence ID: ' + ex.udSentId : ''].filter(Boolean).join(' · ');
      const linkHtml = link
        ? `<a class="pair-example-link ${link.tier === 'fallback' ? 'fallback' : ''}" href="${escapeAttr(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a>`
        : '';
      return `<div class="pair-example">
        ${renderKwicOriginal(ex, word1, word2)}
        ${renderKwicTranslation(ex)}
        <div class="pair-example-meta"><span>${escapeHtml(metaLeft)}</span>${linkHtml}</div>
      </div>`;
    }).join('');
  } else {
    examplesHtml = `<p class="empty-note" style="font-size:15px;">There are no example sentences for this pair yet. To add some, open a second file with sentences along with your word pairs (the Help page explains how).</p>`;
  }

  $('pair-modal-body').innerHTML = `
    <div class="pair-title-row">
      <span class="pair-word slot1">${escapeHtml(word1)}</span>
      <span class="pair-plus">+</span>
      <span class="pair-word slot2">${escapeHtml(word2)}</span>
    </div>
    <div class="pair-subtitle">${escapeHtml(App.labels.slot1)} + ${escapeHtml(App.labels.slot2)}</div>

    <div class="pair-stats-row">
      <div class="pair-stat-card">
        <div class="pair-stat-label">Mutual strength</div>
        <div class="pair-stat-what">How tightly the two words are tied together.</div>
        <div class="pair-stat-value">${row.sym == null ? '–' : row.sym.toFixed(3)}</div>
        <div class="pair-rank-note">${rankText('sym')}</div>
      </div>
      ${row.asym2 != null || App.rows.some(r => r.asym2 != null) ? `
      <div class="pair-stat-card">
        <div class="pair-stat-label">${escapeHtml(App.labels.slot1)} → ${escapeHtml(App.labels.slot2)}</div>
        <div class="pair-stat-what">How strongly “${escapeHtml(word1)}” pulls “${escapeHtml(word2)}”.</div>
        <div class="pair-stat-value">${row.asym == null ? '–' : row.asym.toFixed(3)}</div>
        <div class="pair-rank-note">${rankText('asym', 1)}</div>
      </div>
      <div class="pair-stat-card">
        <div class="pair-stat-label">${escapeHtml(App.labels.slot2)} → ${escapeHtml(App.labels.slot1)}</div>
        <div class="pair-stat-what">How strongly “${escapeHtml(word2)}” pulls “${escapeHtml(word1)}”.</div>
        <div class="pair-stat-value">${row.asym2 == null ? '–' : row.asym2.toFixed(3)}</div>
        <div class="pair-rank-note">${rankText('asym2', 2)}</div>
      </div>` : `
      <div class="pair-stat-card">
        <div class="pair-stat-label">One-way pull</div>
        <div class="pair-stat-what">A direction-sensitive score for the pair.</div>
        <div class="pair-stat-value">${row.asym == null ? '–' : row.asym.toFixed(3)}</div>
        <div class="pair-rank-note">${rankText('asym')}</div>
      </div>`}
    </div>

    ${attrsHtml ? `<div class="section-label">Tags</div><div class="pair-attrs">${attrsHtml}</div>` : ''}

    <div class="section-label">Example sentences</div>
    ${examplesHtml}
  `;

  $('pair-modal-body').querySelectorAll('.kwic-gap').forEach(span => {
    span.addEventListener('click', () => toggleKwicGap(span));
  });

  openModal('pair-modal-backdrop');
}

// One listener per gap span, attached once, toggling between collapsed
// (edges + "N chars" label) and fully expanded — works either direction
// since the listener lives on the outer span, not the inner toggle text.
function toggleKwicGap(span) {
  const full = span.dataset.full;
  const expanded = span.dataset.expanded === '1';
  if (expanded) {
    const omitted = full.length - KWIC_GAP_EDGE_CHARS * 2;
    span.innerHTML = escapeHtml(full.slice(0, KWIC_GAP_EDGE_CHARS))
      + `<span class="kwic-gap-toggle" title="Click to show the hidden text">⋯ ${omitted} more characters ⋯</span>`
      + escapeHtml(full.slice(-KWIC_GAP_EDGE_CHARS));
    span.classList.remove('kwic-gap-expanded');
    span.dataset.expanded = '0';
  } else {
    span.textContent = full;
    span.classList.add('kwic-gap-expanded');
    span.dataset.expanded = '1';
  }
}


function closePairDetail() { closeModal('pair-modal-backdrop'); }

/* =========================================================================
   TRY IT ON YOUR OWN TEXT
   Latin-script words are matched when the two words of a pair sit next to
   each other. For Chinese (and other unspaced scripts) a pair is marked when
   word1 is followed by word2 within a few characters, since a collocation
   there often has other words in between.
   ========================================================================= */
const CJK_RE = /[㐀-鿿豈-﫿]/;
const CJK_MAX_GAP = 8; // characters allowed between the two words

function findPairMarks(input) {
  const marks = [];
  const overlaps = (s, e) => marks.some(m => s < m.end && e > m.start);
  const addPair = (r, s1, e1, s2, e2) => {
    if (overlaps(s1, e1) || overlaps(s2, e2)) return;
    marks.push({ start: s1, end: e1, cls: 'hit1', word: r.word1, slot: 'slot1' });
    marks.push({ start: s2, end: e2, cls: 'hit2', word: r.word2, slot: 'slot2' });
  };

  const latinPairs = new Map();
  const cjkRows = [];
  App.rows.forEach(r => {
    if (CJK_RE.test(r.word1) || CJK_RE.test(r.word2)) cjkRows.push(r);
    else latinPairs.set((r.word1 + '|' + r.word2).toLowerCase(), r);
  });

  const toks = [];
  const re = /[A-Za-zÀ-ɏ'’-]+/g;
  let m;
  while ((m = re.exec(input))) toks.push({ s: m.index, e: m.index + m[0].length, t: m[0] });
  for (let k = 0; k < toks.length - 1; k++) {
    const a = toks[k], b = toks[k + 1];
    if (!/^\s+$/.test(input.slice(a.e, b.s))) continue; // only plain spaces between the words
    const r = latinPairs.get((a.t + '|' + b.t).toLowerCase());
    if (r) addPair(r, a.s, a.e, b.s, b.e);
  }

  cjkRows.forEach(r => {
    let i = input.indexOf(r.word1);
    while (i !== -1) {
      const from = i + r.word1.length;
      const j = input.slice(from, from + CJK_MAX_GAP + r.word2.length).indexOf(r.word2);
      if (j !== -1) addPair(r, i, from, from + j, from + j + r.word2.length);
      i = input.indexOf(r.word1, i + 1);
    }
  });

  return marks.sort((a, b) => a.start - b.start);
}

function highlightText() {
  const input = $('text-input').value;
  const out = $('highlight-output');
  if (!App.rows.length) { out.textContent = 'Open some data first.'; return; }
  if (!input.trim()) { out.textContent = 'Paste a passage in the box on the left, then press “Mark word pairs”.'; return; }

  const marks = findPairMarks(input);
  let html = '', pos = 0;
  marks.forEach(mk => {
    html += escapeHtml(input.slice(pos, mk.start));
    html += `<mark class="${mk.cls}" data-word="${escapeAttr(mk.word)}" data-slot="${mk.slot}" title="Show this word's partners">${escapeHtml(input.slice(mk.start, mk.end))}</mark>`;
    pos = mk.end;
  });
  html += escapeHtml(input.slice(pos));

  const n = marks.length / 2;
  const summary = n === 0
    ? 'No word pairs from this data were found in the passage.'
    : `Found ${n} word pair${n === 1 ? '' : 's'}. Click a coloured word to see its partners.`;
  out.innerHTML = `<div class="help-text" style="margin-top:0;">${summary}</div>${html}`;

  out.querySelectorAll('mark').forEach(el => {
    el.addEventListener('click', () => {
      const map = el.dataset.slot === 'slot1' ? App.slot1 : App.slot2;
      if (map.has(el.dataset.word)) focusNode(el.dataset.slot + '::' + el.dataset.word, el.dataset.slot);
    });
  });
}

/* =========================================================================
   LOADING DATA
   ========================================================================= */
function refreshAll() {
  const hadNoData = document.body.classList.contains('no-data');
  document.body.classList.toggle('no-data', !App.rows.length);
  if (hadNoData && App.rows.length && App.cy) App.cy.resize();
  renderFilterPanel();
  renderWordLists();
  renderGraph();
  if (App.focal) {
    const map = App.focal.slot === 'slot1' ? App.slot1 : App.slot2;
    const node = map.get(App.focal.word);
    if (node) renderDetailPanel(node, App.focal.slot);
  }
}

// Only the labels changed: update text without re-laying-out the picture
function refreshLabels() {
  renderFilterPanel();
  renderWordLists();
  if (App.slot1.size) { renderLegend(); renderGraphBar(); }
  if (App.focal) {
    const map = App.focal.slot === 'slot1' ? App.slot1 : App.slot2;
    const node = map.get(App.focal.word);
    if (node) renderDetailPanel(node, App.focal.slot);
  }
  renderDatasetInfo();
}

function renderDatasetInfo() {
  $('info-slot1-label').textContent = App.labels.slot1;
  $('info-slot2-label').textContent = App.labels.slot2;
  if (!App.rows.length) {
    ['info-name','info-pairs','info-slot1-count','info-slot2-count','info-examples'].forEach(id => { $(id).textContent = '–'; });
    $('info-attrs').innerHTML = '<p class="empty-note">Open some data to see details.</p>';
    return;
  }
  $('info-name').textContent = App.datasetName || '–';
  $('info-pairs').textContent = App.rows.length;
  $('info-slot1-count').textContent = App.slot1.size + ' different words';
  $('info-slot2-count').textContent = App.slot2.size + ' different words';
  const exTotal = Array.from(App.examples.values()).reduce((s, arr) => s + arr.length, 0);
  $('info-examples').textContent = exTotal ? `${exTotal} (for ${App.examples.size} pairs)` : 'none loaded';

  const scopeName = { w1: App.labels.slot1 + ' tags', w2: App.labels.slot2 + ' tags', pair: 'Pair tags' };
  let html = '';
  ['w1', 'w2', 'pair'].forEach(scope => {
    const types = Object.keys(App.attrSchema[scope]);
    if (!types.length) return;
    html += `<div class="attr-row"><span class="k">${escapeHtml(scopeName[scope])}</span><span class="v">${types.map(t => escapeHtml(pretty(t))).join(', ')}</span></div>`;
  });
  $('info-attrs').innerHTML = html || '<p class="empty-note">No tags in this data.</p>';
}

// Returns how many rows were unusable (a word missing)
function loadData(rawRows, name) {
  const { rows, slot1, slot2, attrSchema } = buildIndices(rawRows);
  App.rows = rows; App.slot1 = slot1; App.slot2 = slot2; App.attrSchema = attrSchema;
  App.datasetName = name || '';
  App.filters = { w1: {}, w2: {}, pair: {} };
  App.focal = null;
  App.overviewPositions = null;       // recompute the layout for the new data
  App.wordListExpanded = { w1: false, w2: false };
  App.wordQuery = ''; $('word-search').value = '';
  App.examples = new Map();           // examples belong to a dataset; clear until (re-)opened
  App.collocateSort = { col: null, dir: 'desc' };
  const ta = $('text-input');
  if (ta.value === App.defaultText) ta.value = '';
  App.defaultText = '';
  $('highlight-output').textContent = 'Press “Mark word pairs” and the pairs found will be coloured here. Click a coloured word to jump to it.';
  renderDetailEmpty();
  refreshAll();
  renderDatasetInfo();
  return rawRows.length - rows.length;
}

function setExamples(rawRows) {
  App.examples = parseExamplesCSV(rawRows);
  renderDatasetInfo();
  return Array.from(App.examples.values()).reduce((s, arr) => s + arr.length, 0);
}

const SAMPLE_TEXT = 'The strong coffee and heavy rain made for a big decision about a fresh start.\n學而時習之，不亦說乎。有朋自遠方來，不亦樂乎。';

function loadSample() {
  loadData(parseCSVText(SAMPLE_CSV), 'Example data (made-up English pairs and two Chinese ones)');
  setExamples(parseCSVText(SAMPLE_EXAMPLES_CSV));
  $('text-input').value = SAMPLE_TEXT;
  App.defaultText = SAMPLE_TEXT;
  notify('The example is open. Click any word to see its partners.');
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('the Excel reader could not be loaded (are you online?)'));
    document.head.appendChild(s);
  });
}

// Takes one or several files (CSV or Excel), works out which is the word-pair
// table and which holds example sentences, and opens them.
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const tables = [], problems = [];

  for (const f of files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    try {
      if (ext === 'xlsx' || ext === 'xls') {
        await loadScriptOnce(XLSX_URL);
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        wb.SheetNames.forEach(n => {
          tables.push({ name: f.name, sheet: n, text: XLSX.utils.sheet_to_csv(wb.Sheets[n]) });
        });
      } else {
        const text = await f.text();
        if (text.includes('�')) {
          problems.push(`“${f.name}” does not seem to be saved as UTF-8, so some characters may look wrong. In Excel, use Save As → “CSV UTF-8”.`);
        }
        tables.push({ name: f.name, text });
      }
    } catch (err) {
      problems.push(`I could not read “${f.name}”: ${err.message}`);
    }
  }

  let pairs = null, exs = null;
  tables.forEach(t => {
    const rows = parseCSVText(t.text);
    const kind = detectKind(rows);
    if (kind === 'pairs' && !pairs) pairs = { name: t.name, rows };
    else if (kind === 'examples' && !exs) exs = { name: t.name, rows };
    else if (!kind && rows.length) {
      problems.push(`I could not find columns named “word1” and “word2” in “${t.name}”${t.sheet ? ' (sheet ' + t.sheet + ')' : ''}. The first row must contain the column names (see Help).`);
    }
  });

  const parts = [];
  let kind = 'info';
  if (pairs) {
    const usable = pairs.rows.some(r => (r.word1 || '').trim() && (r.word2 || '').trim());
    if (!usable) {
      problems.push(`“${pairs.name}” has no rows with both word1 and word2 filled in.`);
      pairs = null;
    }
  }
  if (pairs) {
    const cols = Object.keys(pairs.rows[0]);
    const skipped = loadData(pairs.rows, pairs.name);
    parts.push(`Opened “${pairs.name}”: ${App.rows.length} word pairs.`);
    if (skipped > 0) { problems.push(`${skipped} row${skipped === 1 ? ' was' : 's were'} skipped because a word was missing.`); }
    if (!cols.includes('sym_score') && !cols.includes('asym_score') && !cols.includes('asym_score_2')) {
      problems.push('There are no score columns (sym_score, asym_score), so distances in the picture will not mean anything.');
    }
  }
  if (exs) {
    if (!App.rows.length) {
      problems.push(`“${exs.name}” contains example sentences, but no word pairs are open yet. Open the word-pair file too (you can select both files at once).`);
    } else {
      const n = setExamples(exs.rows);
      if (n) parts.push(`${n} example sentence${n === 1 ? '' : 's'} added.`);
      else problems.push(`“${exs.name}” had no usable sentences (each row needs word1, word2 and text).`);
    }
  }
  if (!pairs && !exs && !problems.length) problems.push('Nothing in the chosen file could be read.');

  if (problems.length) kind = (pairs || exs) ? 'warn' : 'error';
  if (pairs) parts.push('Click a word to see its partners.');
  notify([...parts, ...problems].join(' '), kind, kind !== 'info');
}

/* =========================================================================
   DOWNLOAD / CITE / HELP
   ========================================================================= */
const TEMPLATE_PAIRS_CSV =
`word1,word2,sym_score,asym_score,asym_score_2,attr_w1_theme,attr_w2_theme,attr_pair_kind
strong,coffee,12.4,0.61,0.34,intensity,beverage,literal
heavy,rain,18.7,0.70,0.70,intensity,weather,literal
`;
const TEMPLATE_EXAMPLES_CSV =
`word1,word2,text,translation,source_label
strong,coffee,The strong coffee kept him awake.,,My notes p. 12
`;

function downloadCurrentCsv() {
  const attrTypes = { w1: Object.keys(App.attrSchema.w1), w2: Object.keys(App.attrSchema.w2), pair: Object.keys(App.attrSchema.pair) };
  const hasAsym2 = App.rows.some(r => r.asym2 != null);
  const headers = ['word1', 'word2', 'sym_score', 'asym_score', ...(hasAsym2 ? ['asym_score_2'] : []),
    ...attrTypes.pair.map(t => 'attr_pair_' + t),
    ...attrTypes.w1.map(t => 'attr_w1_' + t),
    ...attrTypes.w2.map(t => 'attr_w2_' + t)];
  const csvEscape = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const lines = [headers.join(',')];
  App.rows.forEach(row => {
    const cells = [row.word1, row.word2, row.sym ?? '', row.asym ?? '', ...(hasAsym2 ? [row.asym2 ?? ''] : [])];
    attrTypes.pair.forEach(t => cells.push(row.attrs.pair[t] || ''));
    attrTypes.w1.forEach(t => cells.push(row.attrs.w1[t] || ''));
    attrTypes.w2.forEach(t => cells.push(row.attrs.w2[t] || ''));
    lines.push(cells.map(c => csvEscape(String(c))).join(','));
  });
  downloadText('word_pairs.csv', lines.join('\n'));
}

function openCiteModal() {
  const today = new Date().toISOString().slice(0, 10);
  const c = SITE_CONFIG;
  const servedOnWeb = /^https?:/.test(location.protocol);
  const bits = {
    authors: c.authors || '[Author]',
    year: c.year || new Date().getFullYear(),
    title: c.datasetTitle || '[Dataset title]',
    url: c.url || (servedOnWeb ? location.href.split('#')[0] : '[web address]')
  };
  const text = `${bits.authors}. ${bits.year}. ${bits.title}. ${c.siteName} [Data set]. Available online at ${bits.url}, accessed on ${today}.`;
  $('cite-block').textContent = text;
  $('cite-note').textContent = /\[/.test(text)
    ? 'Details in [square brackets] have not been filled in yet. Whoever runs this site can set them in SITE_CONFIG at the top of the page’s script.'
    : '';
  openModal('cite-modal-backdrop');
}
function closeCiteModal() { closeModal('cite-modal-backdrop'); }

function openHelp(sectionId) {
  openModal('help-modal-backdrop');
  const target = sectionId && $(sectionId);
  if (target) target.scrollIntoView();
}

/* =========================================================================
   EVENT WIRING
   ========================================================================= */
function needData(then) {
  return e => {
    e.preventDefault();
    if (!App.rows.length) { notify('Open some data first. You can start with the example.', 'warn'); return; }
    then();
  };
}
function showLeftPane() {
  if ($('left-pane').classList.contains('collapsed')) setPaneCollapsed('left', false);
}
function openAccordion(id) {
  const acc = $(id);
  acc.classList.remove('collapsed');
  const h = acc.querySelector('.accordion-header');
  if (h) h.setAttribute('aria-expanded', 'true');
  acc.scrollIntoView({ block: 'nearest' });
}

// file choosing
$('data-file').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
['header-open', 'welcome-open'].forEach(id => $(id).addEventListener('click', () => $('data-file').click()));
['header-sample', 'welcome-sample'].forEach(id => $(id).addEventListener('click', loadSample));

// drag a file anywhere onto the page
let dragDepth = 0;
const dragHasFiles = e => !FIXED && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', e => { if (dragHasFiles(e)) { e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; } });
window.addEventListener('dragover', e => { if (dragHasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
window.addEventListener('drop', e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
  handleFiles(e.dataTransfer.files);
});

// accordions
document.querySelectorAll('.accordion-header').forEach(btn => {
  btn.addEventListener('click', () => {
    const acc = btn.closest('.accordion');
    acc.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', acc.classList.contains('collapsed') ? 'false' : 'true');
  });
});

// collapsing whole side panels
const PANE_EXPANDED_WIDTH = { left: '300px', right: '340px' };
function setPaneCollapsed(side, collapsed) {
  $(side + '-pane').classList.toggle('collapsed', collapsed);
  document.documentElement.style.setProperty('--' + side + '-w', collapsed ? '48px' : PANE_EXPANDED_WIDTH[side]);
  const btn = $(side + '-pane-toggle');
  btn.textContent = collapsed ? (side === 'left' ? '›' : '‹') : (side === 'left' ? '‹' : '›');
  const tip = collapsed ? 'Show this panel' : 'Hide this panel';
  btn.title = tip; btn.setAttribute('aria-label', tip);
}
['left', 'right'].forEach(side => {
  $(side + '-pane-toggle').addEventListener('click', () => setPaneCollapsed(side, !$(side + '-pane').classList.contains('collapsed')));
});

// find a word
$('word-search').addEventListener('input', e => {
  App.wordQuery = e.target.value;
  if (App.wordQuery.trim()) { openAccordion('accordion-slot1'); openAccordion('accordion-slot2'); }
  renderWordLists();
});
$('word-search').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const best = bestSearchMatch();
  if (best) focusNode(best.id, best.slot);
  else notify('No word matches “' + App.wordQuery.trim() + '”.', 'warn');
});

// navigation
const goHome = e => {
  e.preventDefault();
  if (!App.rows.length) return;
  App.focal = null;
  App.filters = { w1: {}, w2: {}, pair: {} };
  renderDetailEmpty();
  refreshAll();
};
$('nav-home').addEventListener('click', goHome);
$('brand-link').addEventListener('click', goHome);
$('nav-words').addEventListener('click', needData(() => {
  showLeftPane(); openAccordion('accordion-slot1'); openAccordion('accordion-slot2'); $('word-search').focus();
}));
$('nav-filters').addEventListener('click', needData(() => { showLeftPane(); openAccordion('accordion-filters'); }));
$('nav-download').addEventListener('click', needData(downloadCurrentCsv));
$('nav-cite').addEventListener('click', e => { e.preventDefault(); openCiteModal(); });
$('nav-help').addEventListener('click', e => { e.preventDefault(); openHelp(); });
$('welcome-help').addEventListener('click', e => { e.preventDefault(); openHelp('help-own-data'); });
$('footer-help-link').addEventListener('click', e => { e.preventDefault(); openHelp(); });
$('footer-cite-link').addEventListener('click', e => { e.preventDefault(); openCiteModal(); });
$('dl-template-pairs').addEventListener('click', () => downloadText('word_pairs_template.csv', TEMPLATE_PAIRS_CSV));
$('dl-template-examples').addEventListener('click', () => downloadText('example_sentences_template.csv', TEMPLATE_EXAMPLES_CSV));

// dialogs
$('pair-modal-close').addEventListener('click', closePairDetail);
$('cite-modal-close').addEventListener('click', closeCiteModal);
$('help-modal-close').addEventListener('click', () => closeModal('help-modal-backdrop'));
['pair-modal-backdrop', 'cite-modal-backdrop', 'help-modal-backdrop'].forEach(id => {
  $(id).addEventListener('click', evt => { if (evt.target.id === id) closeModal(id); });
});
document.addEventListener('keydown', evt => {
  if (evt.key === 'Escape') ['pair-modal-backdrop', 'cite-modal-backdrop', 'help-modal-backdrop'].forEach(closeModal);
});
$('cite-copy-btn').addEventListener('click', () => {
  const text = $('cite-block').textContent;
  const btn = $('cite-copy-btn');
  const done = () => { btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = 'Copy citation'; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => {});
});

// graph bar
$('graph-back').addEventListener('click', clearFocus);
$('graph-clear-filters').addEventListener('click', clearAllFilters);
$('notice-close').addEventListener('click', hideNotice);

// display options
$('metric-toggle').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  App.metric = btn.dataset.v;
  document.querySelectorAll('#metric-toggle button').forEach(b => b.classList.toggle('active', b === btn));
  refreshAll();
});
const SCALE_DESC = {
  rank: 'Partners are spaced evenly, strongest first. Good for a tidy picture.',
  raw: 'Distance is proportional to the score, so one very strong partner can leave the others bunched together.',
  log: 'Like “True scale”, but softened so a few very high scores do not squash everything else.'
};
$('scale-toggle').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  App.scale = btn.dataset.v;
  document.querySelectorAll('#scale-toggle button').forEach(b => b.classList.toggle('active', b === btn));
  $('scale-desc').textContent = SCALE_DESC[App.scale];
  renderGraph();
});
function syncAnimateButtons() {
  document.querySelectorAll('#animate-toggle button').forEach(b => b.classList.toggle('active', (b.dataset.v === 'on') === App.animationEnabled));
}
$('animate-toggle').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  App.animationEnabled = btn.dataset.v === 'on';
  syncAnimateButtons();
  updateAnimStatus();
});
$('animate-threshold').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  App.animationThreshold = isNaN(v) ? 60 : v;
  updateAnimStatus();
});
['slot1', 'slot2'].forEach(k => {
  $('label-' + k).addEventListener('input', e => {
    App.labels[k] = e.target.value.trim() || DEFAULT_LABELS[k];
    refreshLabels();
  });
});

// own-text drawer
$('drawer-head').addEventListener('click', () => {
  const d = $('drawer');
  d.classList.toggle('collapsed');
  const open = !d.classList.contains('collapsed');
  $('drawer-arrow').textContent = open ? '▾' : '▸';
  $('drawer-head').setAttribute('aria-expanded', open ? 'true' : 'false');
});
$('highlight-btn').addEventListener('click', highlightText);

// keep the picture sized to its box (panels opening/closing, window resizing)
let fitTimer = null;
new ResizeObserver(() => {
  if (!App.cy || !$('cy-holder').offsetWidth) return;
  App.cy.resize();
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { if (App.cy.nodes().length) { App.cy.fit(undefined, 50); markFitZoom(); } }, 160);
}).observe($('cy-holder'));

/* =========================================================================
   START-UP
   ========================================================================= */
(function init() {
  const c = SITE_CONFIG;
  $('site-name').textContent = c.siteName;
  document.title = c.siteName + ' – ' + (c.datasetTitle || 'explore which words go together');
  $('footer-license').textContent = c.license || '';
  if (c.sourceUrl) {
    $('footer-source-link').href = c.sourceUrl;
    $('footer-source-link').hidden = false;
    $('footer-source-sep').hidden = false;
  }
  // people who ask their computer for less motion get no animation by default
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) App.animationEnabled = false;
  syncAnimateButtons();
  $('label-slot1').value = ''; $('label-slot2').value = '';
  initCy();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (App.cy) App.cy.forceRender(); });
  renderDetailEmpty();
  updateAnimStatus();

  if (!FIXED) return;
  // ---- fixed-data site: apply the owner's settings and open the data straight away ----
  document.body.classList.add('fixed');
  const g = c.groupNames || {};
  if (g.first) App.labels.slot1 = g.first;
  if (g.second) App.labels.slot2 = g.second;
  if (c.defaultDistance === 'sym' || c.defaultDistance === 'asym') App.metric = c.defaultDistance;
  if (['rank', 'raw', 'log'].includes(c.defaultSpacing)) App.scale = c.defaultSpacing;
  document.querySelectorAll('#metric-toggle button').forEach(b => b.classList.toggle('active', b.dataset.v === App.metric));
  document.querySelectorAll('#scale-toggle button').forEach(b => b.classList.toggle('active', b.dataset.v === App.scale));
  $('scale-desc').textContent = SCALE_DESC[App.scale];
  if (c.about && c.about.trim()) {
    const paras = c.about.trim().split(/\n\s*\n/);
    const fill = (el, cls) => { paras.forEach(t => { const p = document.createElement('p'); p.textContent = t; if (cls) p.className = cls; el.appendChild(p); }); };
    fill($('help-about'));
    $('help-about').hidden = false;
    const h = document.createElement('h3'); h.textContent = 'About this dataset'; $('help-about').prepend(h);
    fill($('info-about'), 'help-text');
    $('info-about').hidden = false;
  }
  const D = window.COLLOMAP_DATA;
  loadData(parseCSVText(D.pairsCsv), c.datasetTitle || 'This dataset');
  if (D.examplesCsv) setExamples(parseCSVText(D.examplesCsv));
  if (c.sampleText) { $('text-input').value = c.sampleText; App.defaultText = c.sampleText; }
})();
