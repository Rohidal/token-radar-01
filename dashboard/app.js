// Launch Radar page: reads window.RADAR (written by main.ts beside dashboard/) and renders the
// ranked board, its filters, a per-protocol detail panel with the model's own numbers and the farm
// plan, the live-token set the model learns from, and the method behind the pricing. No network:
// every byte it shows comes from data.js, and every figure is quoted from the row it belongs to.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var body = document.getElementById('rows');
  if (!DATA || !body) return;

  var state = { q: '', category: 'all', watchlist: false, sort: 'implied', dir: -1, selected: null, view: 'board' };
  function $(id) { return document.getElementById(id); }

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + String(Math.round(n));
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return '-';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 730) return (days / 365).toFixed(1) + 'y';
    if (days >= 60) return Math.round(days / 30.4) + 'mo';
    return days + 'd';
  }
  function tone(n) { return n === null || n === undefined || n === 0 ? 'flat' : n > 0 ? 'up' : 'down'; }
  function categoryOf(r) { return r.category === null ? 'Uncategorised' : r.category; }
  function txt(node, value) { if (node) node.textContent = value === null || value === undefined ? '-' : String(value); return node; }

  // ------------------------------------------------------------------ shell

  txt($('stamp-date'), DATA.as_of);
  txt($('stamp-model'), DATA.model.version);
  txt($('stamp-comps'), DATA.comps.global_sample + ' protocols, median ' + DATA.comps.global.toFixed(2) + 'x');
  txt($('foot-source'), 'Source: ' + DATA.source);

  function kpi(label, value, note) {
    var box = document.createElement('div');
    box.className = 'kpi';
    var s = document.createElement('span');
    s.textContent = label;
    var b = document.createElement('b');
    b.textContent = value;
    var small = document.createElement('small');
    small.textContent = note;
    box.appendChild(s); box.appendChild(b); box.appendChild(small);
    return box;
  }

  function renderKpis() {
    var box = $('kpis');
    box.textContent = '';
    var top = DATA.rows[0];
    box.appendChild(kpi('On the watchlist', String(DATA.watchlist_size), 'records no token, over ' + fmtUsd(DATA.floor_usd)));
    box.appendChild(kpi('Ranked rows', String(DATA.board_size), DATA.early_size + ' early, below the floor'));
    box.appendChild(kpi('Largest implied value', fmtUsd(top.implied_value_usd), 'rank 1 ' + top.name));
    box.appendChild(kpi('TVL the board covers', fmtUsd(DATA.totals.tvl_usd), DATA.totals.growth_up + ' up, ' + DATA.totals.growth_down + ' down in 7d'));
  }

  // ------------------------------------------------------------------ filters

  function renderChips() {
    var seen = {};
    DATA.rows.forEach(function (r) { var c = categoryOf(r); seen[c] = (seen[c] || 0) + 1; });
    var list = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || (a < b ? -1 : 1); }).slice(0, 9);
    var box = $('chips');
    box.textContent = '';
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip';
    all.textContent = 'All ' + DATA.rows.length;
    all.setAttribute('aria-pressed', String(state.category === 'all'));
    all.onclick = function () { state.category = 'all'; render(); };
    box.appendChild(all);
    list.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = c + ' ' + seen[c];
      b.setAttribute('aria-pressed', String(state.category === c));
      b.onclick = function () { state.category = c; render(); };
      box.appendChild(b);
    });
  }

  function matches(r) {
    if (state.watchlist && !r.watchlist) return false;
    if (state.category !== 'all' && categoryOf(r) !== state.category) return false;
    if (state.q === '') return true;
    var q = state.q.toLowerCase();
    var hay = [r.name, r.slug, r.category || '', r.chains.join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function sorted(rows) {
    var list = rows.slice();
    list.sort(function (a, b) {
      var x, y;
      if (state.sort === 'name') { x = a.name.toLowerCase(); y = b.name.toLowerCase(); }
      else if (state.sort === 'tvl') { x = a.tvl_usd; y = b.tvl_usd; }
      else if (state.sort === 'growth') { x = a.change_7d === null ? -999 : a.change_7d; y = b.change_7d === null ? -999 : b.change_7d; }
      else if (state.sort === 'age') { x = a.age_days === null ? -1 : a.age_days; y = b.age_days === null ? -1 : b.age_days; }
      else { x = a.implied_value_usd; y = b.implied_value_usd; }
      if (x === y) return a.rank - b.rank;
      return x < y ? -state.dir : state.dir;
    });
    return list;
  }

  // ------------------------------------------------------------------ board

  function renderBoard() {
    var rows = sorted(DATA.rows.filter(matches));
    var peak = DATA.rows[0].implied_value_usd || 1;
    body.textContent = '';
    rows.slice(0, 220).forEach(function (r) {
      var tr = document.createElement('tr');
      tr.setAttribute('aria-selected', String(state.selected === r.slug));
      tr.onclick = function () { state.selected = r.slug; render(); };

      var rank = document.createElement('td');
      rank.className = 'num rank';
      rank.textContent = String(r.rank);
      tr.appendChild(rank);

      var name = document.createElement('td');
      name.className = 'name';
      var b = document.createElement('b');
      b.textContent = r.name;
      var sub = document.createElement('span');
      sub.textContent = r.chains.slice(0, 3).join(' / ') || r.slug;
      name.appendChild(b); name.appendChild(sub);
      tr.appendChild(name);

      var cat = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = categoryOf(r);
      cat.appendChild(tag);
      tr.appendChild(cat);

      var tvl = document.createElement('td');
      tvl.className = 'num';
      tvl.textContent = fmtUsd(r.tvl_usd);
      tr.appendChild(tvl);

      var chg = document.createElement('td');
      chg.className = 'num ' + tone(r.change_7d);
      chg.textContent = fmtPct(r.change_7d);
      tr.appendChild(chg);

      var age = document.createElement('td');
      age.className = 'num';
      age.textContent = fmtAge(r.age_days);
      tr.appendChild(age);

      var val = document.createElement('td');
      val.className = 'num value';
      val.textContent = fmtUsd(r.implied_value_usd);
      if (r.watchlist) {
        var mark = document.createElement('span');
        mark.className = 'mark';
        mark.textContent = '\u2022';
        mark.title = 'on the watchlist';
        val.appendChild(mark);
      }
      tr.appendChild(val);

      var bar = document.createElement('td');
      bar.className = 'barcol';
      var wrap = document.createElement('div');
      wrap.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = Math.max(2, Math.round((r.implied_value_usd / peak) * 100)) + '%';
      wrap.appendChild(fill);
      bar.appendChild(wrap);
      tr.appendChild(bar);

      body.appendChild(tr);
    });
    txt($('count'), rows.length + ' of ' + DATA.rows.length + ' rows' + (state.category === 'all' ? '' : ' in ' + state.category) + (state.watchlist ? ', watchlist only' : '') + ' \u2014 sorted by ' + $('sort').value.toLowerCase());
  }

  // ------------------------------------------------------------------ detail

  function cell(tr, className, content) {
    var td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = content === null || content === undefined ? '-' : String(content);
    tr.appendChild(td);
    return td;
  }

  function detailRow(label, value, className) {
    var d = document.createElement('div');
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value;
    if (className) dd.className = className;
    d.appendChild(dt); d.appendChild(dd);
    return d;
  }

  function renderDetail() {
    var panel = $('detail');
    panel.textContent = '';
    var r = null;
    DATA.rows.forEach(function (row) { if (row.slug === state.selected) r = row; });
    if (!r) {
      var p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Pick a row to read its numbers and its farm plan.';
      panel.appendChild(p);
      return;
    }

    var h = document.createElement('h2');
    h.textContent = r.name;
    panel.appendChild(h);
    var slug = document.createElement('p');
    slug.className = 'slug';
    slug.textContent = 'rank ' + r.rank + ' of ' + DATA.rows.length + ' \u00b7 ' + r.slug + (r.watchlist ? ' \u00b7 on the watchlist' : ' \u00b7 early radar');
    panel.appendChild(slug);

    var stats = document.createElement('dl');
    stats.className = 'dstats';
    stats.appendChild(detailRow('TVL', fmtUsd(r.tvl_usd)));
    stats.appendChild(detailRow('7d change', fmtPct(r.change_7d), tone(r.change_7d)));
    stats.appendChild(detailRow('Tracked since', r.listed_at || 'unknown'));
    stats.appendChild(detailRow('Record', fmtAge(r.age_days)));
    stats.appendChild(detailRow('Category', categoryOf(r)));
    stats.appendChild(detailRow('Implied value', fmtUsd(r.implied_value_usd), 'value'));
    panel.appendChild(stats);

    var walk = document.createElement('div');
    walk.className = 'walk';
    var wh = document.createElement('h3');
    wh.textContent = 'How this number is made';
    walk.appendChild(wh);
    var ol = document.createElement('ol');
    function step(text) { var li = document.createElement('li'); li.innerHTML = text; ol.appendChild(li); }
    step('TVL of <b>' + fmtUsd(r.tvl_usd) + '</b> is what the protocol holds today.');
    step('Its category trades at <b>' + r.multiple.toFixed(3) + 'x</b> TVL' +
      (r.sector_multiple === null ? ' (no category sample: the snapshot-wide median)' : ' (category median <b>' + r.sector_multiple.toFixed(3) + 'x</b>, blended with the snapshot median)') + '.');
    step('Momentum: 7d <b>' + fmtPct(r.change_7d) + '</b> counts at 35%, a factor of <b>' + r.growth_multiplier.toFixed(3) + 'x</b>.');
    step('Track record of <b>' + fmtAge(r.age_days) + '</b> without a token, a factor of <b>' + r.record_multiplier.toFixed(3) + 'x</b>.');
    walk.appendChild(ol);
    var total = document.createElement('p');
    total.className = 'total';
    total.textContent = fmtUsd(r.tvl_usd) + ' \u00d7 ' + r.multiple.toFixed(3) + ' \u00d7 ' + r.growth_multiplier.toFixed(3) + ' \u00d7 ' + r.record_multiplier.toFixed(3) + ' = ' + fmtUsd(r.implied_value_usd);
    walk.appendChild(total);
    panel.appendChild(walk);

    var plan = document.createElement('div');
    plan.className = 'plan';
    var ph = document.createElement('h3');
    ph.textContent = 'Farm it before a launch';
    plan.appendChild(ph);
    var list = document.createElement('ol');
    r.farm_steps.forEach(function (s) { var li = document.createElement('li'); li.textContent = s; list.appendChild(li); });
    plan.appendChild(list);
    panel.appendChild(plan);
  }

  // ------------------------------------------------------------------ live + method

  function renderLive() {
    var box = $('live-rows');
    box.textContent = '';
    DATA.live.forEach(function (p) {
      var tr = document.createElement('tr');
      cell(tr, 'name', p.name + (p.symbol ? ' (' + p.symbol + ')' : ''));
      cell(tr, '', p.category === null ? 'Uncategorised' : p.category);
      cell(tr, 'num', fmtUsd(p.tvl_usd));
      cell(tr, 'num', fmtUsd(p.mcap_usd));
      cell(tr, 'num value', p.mcap_usd && p.tvl_usd ? (p.mcap_usd / p.tvl_usd).toFixed(3) + 'x' : 'n/a');
      cell(tr, 'num ' + tone(p.change_7d), fmtPct(p.change_7d));
      box.appendChild(tr);
    });
  }

  function renderComps() {
    var box = $('comps-rows');
    box.textContent = '';
    DATA.comps.sectors.forEach(function (s) {
      var tr = document.createElement('tr');
      cell(tr, '', s.category);
      cell(tr, 'num value', s.multiple.toFixed(3) + 'x');
      cell(tr, 'num', String(s.sample));
      box.appendChild(tr);
    });
    txt($('comps-note'), 'Snapshot median across ' + DATA.comps.global_sample + ' token-bearing protocols: ' + DATA.comps.global.toFixed(3) + 'x. A category needs four comparables to set its own multiple; the rest use this median.');
  }

  // ------------------------------------------------------------------ events + render

  function show(view) {
    state.view = view;
    ['board', 'live', 'method'].forEach(function (v) {
      $('view-' + v).hidden = v !== view;
      $('tab-' + v).setAttribute('aria-selected', String(v === view));
    });
  }

  function render() {
    renderKpis();
    renderChips();
    renderBoard();
    renderDetail();
    txt($('watchonly-cap'), 'Watchlist only (' + DATA.watchlist_size + ')');
  }

  $('q').oninput = function (e) { state.q = e.target.value.trim(); render(); };
  $('sort').onchange = function (e) {
    state.sort = e.target.value;
    state.dir = state.sort === 'name' ? 1 : -1;
    render();
  };
  $('watchonly').onchange = function (e) { state.watchlist = e.target.checked; render(); };
  ['board', 'live', 'method'].forEach(function (v) {
    $('tab-' + v).onclick = function () { show(v); };
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { state.selected = null; renderDetail(); }
  });

  // Hooks the screenshot run uses to place the page in a known state; they change nothing else.
  window.radarFilter = function (patch) {
    if (patch.q !== undefined) { state.q = patch.q; $('q').value = patch.q; }
    if (patch.category !== undefined) state.category = patch.category;
    if (patch.watchlist !== undefined) { state.watchlist = !!patch.watchlist; $('watchonly').checked = state.watchlist; }
    if (patch.sort !== undefined) { state.sort = patch.sort; $('sort').value = patch.sort; state.dir = patch.sort === 'name' ? 1 : -1; }
    if (patch.selected !== undefined) state.selected = patch.selected;
    if (patch.view !== undefined) show(patch.view);
    render();
  };

  show('board');
  renderLive();
  renderComps();
  state.selected = DATA.rows[0].slug; // the panel always opens on rank 1, so the page is never blank
  render();
})();