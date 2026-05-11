const money = (value) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
}).format(Number(value || 0));

const pct = (value) => `${Number(value || 0).toFixed(2)}%`;
const num = (value) => Number(value || 0).toLocaleString();
const price = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

function shortTime(value) {
  if (!value) return 'n/a';
  const number = Number(value);
  const date = Number.isFinite(number) && number > 0
    ? new Date((number > 100000000000 ? number : number * 1000))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? 'n/a' : date.toISOString().slice(0, 16).replace('T', ' ');
}

function metric(label, value, className = '') {
  return `<div class="metric"><div class="label">${label}</div><div class="value ${className}">${value}</div></div>`;
}

function row(cells) {
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

function colorForNet(value) {
  return Number(value || 0) >= 0 ? 'good' : 'bad';
}

function colorForQuality(value) {
  const number = Number(value || 0);
  if (number >= 78) return 'good';
  if (number >= 62) return 'warn';
  return 'bad';
}

async function loadDashboard() {
  const response = await fetch('./data/dashboard.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`dashboard.json ${response.status}`);
  return response.json();
}

function renderSummary(data) {
  const champion = data.champion;
  const pattern = data.patternLab;
  const canonical = data.canonical;
  const forward = data.forward?.latestPhase18?.metrics;
  document.getElementById('updatedAt').textContent = `Updated ${new Date(data.updatedAt).toLocaleString()}`;
  document.getElementById('summaryCards').innerHTML = [
    metric('Champion Net', money(champion?.metrics?.netDollars), colorForNet(champion?.metrics?.netDollars)),
    metric('Champion Win', pct(champion?.metrics?.winRate), 'good'),
    metric('Canonical Trades', num(canonical?.stats?.canonicalTrades || pattern?.data?.trades || 0)),
    metric('Forward Net', money(forward?.netDollars || 0), colorForNet(forward?.netDollars)),
  ].join('');
}

function renderCanonical(data) {
  const canonical = data.canonical || {};
  const stats = canonical.stats || {};
  const metrics = canonical.globalMetrics || {};
  document.getElementById('canonicalBadge').textContent = canonical.updatedAt
    ? `Updated ${new Date(canonical.updatedAt).toLocaleString()}`
    : 'No canonical data';
  document.getElementById('canonicalMetrics').innerHTML = [
    metric('Raw Trades', num(stats.rawTrades || 0)),
    metric('Canonical Trades', num(stats.canonicalTrades || 0), 'good'),
    metric('Duplicates Removed', num(stats.duplicatesRemoved || 0), 'warn'),
    metric('Duplicate Rate', pct(stats.duplicateRate || 0), stats.duplicateRate > 10 ? 'warn' : ''),
    metric('Unique Routes', num(stats.uniqueRoutes || 0)),
    metric('Unique Symbols', num(stats.uniqueSymbols || 0)),
    metric('Global Win', pct(metrics.winRate || 0), metrics.winRate >= 70 ? 'good' : 'warn'),
    metric('Global Net', money(metrics.netDollars || 0), colorForNet(metrics.netDollars)),
    metric('Max DD', money(metrics.maxDrawdownDollars || 0), 'warn'),
    metric('Loss Streak', num(metrics.maxLossStreak || 0)),
    metric('Factory Candidates', num((data.specialistFactory || []).length)),
    metric('Weeks Covered', num(stats.uniqueWeeks || 0)),
  ].join('');

  const routes = canonical.topRoutes || [];
  document.getElementById('canonicalRoutesTable').innerHTML = routes.slice(0, 20).map((route) => row([
    `<strong>${route.symbol}</strong><br><span class="muted">${route.trigger} · ${route.session} · ${route.side}</span>`,
    `${num(route.consistency?.uniqueDays || 0)} / ${num(route.consistency?.uniqueWeeks || 0)}`,
    num(route.metrics?.trades || 0),
    pct(route.metrics?.winRate || 0),
    `<span class="${colorForNet(route.metrics?.netDollars)}">${money(route.metrics?.netDollars)}</span>`,
    `<span class="${colorForQuality(route.qualityScore)}">${Number(route.qualityScore || 0).toFixed(1)}</span>`,
    route.validation?.passed ? '<span class="good">Passed</span>' : '<span class="warn">Needs proof</span>',
  ])).join('') || row(['No canonical routes yet', '', '', '', '', '', '']);
}

function renderChampion(data) {
  const champion = data.champion;
  document.getElementById('championTitle').textContent = champion ? `${champion.phase} · ${champion.bestVariant}` : 'No champion loaded';
  document.getElementById('championBadge').textContent = champion?.qualified ? 'Qualified' : 'Watchlist';
  document.getElementById('championMetrics').innerHTML = [
    metric('Trades', num(champion?.metrics?.trades)),
    metric('Win Rate', pct(champion?.metrics?.winRate), 'good'),
    metric('Net', money(champion?.metrics?.netDollars), colorForNet(champion?.metrics?.netDollars)),
    metric('Avg / Trade', money(champion?.metrics?.avgDollars), colorForNet(champion?.metrics?.avgDollars)),
    metric('Profit Factor', Number(champion?.metrics?.profitFactor || 0).toFixed(2)),
    metric('Holdout Win', pct(champion?.holdout?.winRate), 'good'),
    metric('Stress Net', money(champion?.stress?.netDollars), colorForNet(champion?.stress?.netDollars)),
    metric('Max DD', money(champion?.metrics?.maxDrawdownDollars), 'warn'),
    metric('Loss Streak', num(champion?.metrics?.maxLossStreak)),
    metric('Option Worthy', pct(champion?.metrics?.optionWorthyRate)),
    metric('Watchlist', num(champion?.watchlist?.length || 0)),
    metric('Holdout Trades', num(champion?.holdout?.trades || 0)),
  ].join('');
}

function renderSpecialists(data) {
  const rows = (data.specialists || []).map((specialist) => row([
    `<strong>${specialist.name}</strong><br><span class="muted">${specialist.key}</span>`,
    specialist.status,
    num(specialist.metrics.trades),
    pct(specialist.metrics.winRate),
    `<span class="${colorForNet(specialist.metrics.netDollars)}">${money(specialist.metrics.netDollars)}</span>`,
    Number(specialist.metrics.profitFactor || 0).toFixed(2),
    `${num(specialist.holdout.trades)} / ${pct(specialist.holdout.winRate)}`,
    `<span class="${colorForNet(specialist.stress.netDollars)}">${money(specialist.stress.netDollars)}</span>`,
  ]));
  document.getElementById('specialistsTable').innerHTML = rows.join('') || row(['No specialists loaded', '', '', '', '', '', '', '']);
}

function chips(items, limit = 10) {
  return (items || []).slice(0, limit).map((item) => `<span class="chip">${item}</span>`).join('');
}

function renderSpecialistCards(data) {
  const specialists = data.specialists || [];
  document.getElementById('specialistCards').innerHTML = specialists.map((specialist) => `
    <article class="specialist-card">
      <div>
        <p class="eyebrow">${specialist.status}</p>
        <h3>${specialist.name}</h3>
        <p class="muted">${specialist.purpose || specialist.notes || 'No purpose description yet.'}</p>
      </div>
      <div class="metric-grid">
        ${metric('Trades', num(specialist.metrics.trades))}
        ${metric('Win', pct(specialist.metrics.winRate), specialist.metrics.winRate >= 85 ? 'good' : 'warn')}
        ${metric('Net', money(specialist.metrics.netDollars), colorForNet(specialist.metrics.netDollars))}
        ${metric('Routes', num(specialist.routeCount || 0))}
      </div>
      <div class="detail-list">
        <div><strong>Built for:</strong> ${specialist.bestFor || 'Specialist route evaluation.'}</div>
        <div><strong>Preferred use:</strong> ${specialist.preferredUse || 'n/a'}</div>
        <div><strong>Activation:</strong> ${specialist.activation || 'n/a'}</div>
        ${specialist.forwardFeedback ? `<div><strong>Forward feedback:</strong> ${specialist.forwardFeedback}</div>` : ''}
        ${specialist.validationDecision ? `<div><strong>Validation:</strong> ${specialist.validationDecision}</div>` : ''}
      </div>
      <div>
        <div class="muted">Triggers</div>
        <div class="chip-row">${chips(specialist.triggers, 8) || '<span class="chip">n/a</span>'}</div>
      </div>
      <div>
        <div class="muted">Symbols / universe</div>
        <div class="chip-row">${chips(specialist.symbols, 14) || '<span class="chip">n/a</span>'}</div>
      </div>
    </article>
  `).join('') || '<p class="muted">No specialist details loaded.</p>';
}

function renderTopHits(data) {
  const symbols = data.backtestHits?.topSymbols || data.champion?.topSymbols || [];
  document.getElementById('topSymbolsTable').innerHTML = symbols.map((item) => row([
    `<strong>${item.symbol}</strong>`,
    num(item.metrics?.trades ?? item.trades),
    pct(item.metrics?.winRate ?? item.winRate),
    `<span class="${colorForNet(item.metrics?.netDollars ?? item.netDollars)}">${money(item.metrics?.netDollars ?? item.netDollars)}</span>`,
    money(item.metrics?.avgDollars ?? item.avgDollars),
    item.bestTrade ? `${item.bestTrade.side} · ${money(item.bestTrade.pnlDollars)} · ${item.bestTrade.triggerMode}` : 'n/a',
  ])).join('') || row(['No symbol hit data yet', '', '', '', '', '']);

  const trades = data.backtestHits?.biggestTrades || data.champion?.biggestTrades || [];
  document.getElementById('biggestTrades').innerHTML = trades.slice(0, 10).map((trade) => `
    <div class="mini-card">
      <div class="trade-line">
        <strong>${trade.symbol} · ${trade.side}</strong>
        <span class="${colorForNet(trade.pnlDollars)}">${money(trade.pnlDollars)}</span>
      </div>
      <p class="muted">${trade.triggerMode || trade.trigger} · entry ${price(trade.entry)} → exit ${price(trade.exit)} · MFE ${Number(trade.mfeR || 0).toFixed(2)}R · MAE ${Number(trade.maeR || 0).toFixed(2)}R · conf ${trade.confidence || 0}</p>
      <p class="muted">${shortTime(trade.entryTime)} → ${shortTime(trade.exitTime)}</p>
    </div>
  `).join('') || '<p class="muted">No biggest-trade data yet.</p>';
}

function renderPatterns(data) {
  const patterns = data.patternLab?.topPatterns || [];
  document.getElementById('patternCards').innerHTML = patterns.slice(0, 8).map((pattern) => `
    <div class="mini-card">
      <h3>${pattern.tag}</h3>
      <p class="muted">${num(pattern.metrics.trades)} trades · ${pct(pattern.metrics.winRate)} win · <span class="${colorForNet(pattern.metrics.netDollars)}">${money(pattern.metrics.netDollars)}</span></p>
      <p class="muted">Best edges: ${(pattern.edges || []).slice(0, 3).map((edge) => `${edge.feature} ${edge.edge > 0 ? '+' : ''}${edge.edge}`).join(', ') || 'n/a'}</p>
    </div>
  `).join('') || '<p class="muted">No pattern data yet.</p>';
}

function renderPine(data) {
  const pine = data.pine || {};
  document.getElementById('pineStatus').innerHTML = [
    `<div class="mini-card"><strong>Model</strong><br><span class="muted">${pine.modelId || 'unknown'}</span></div>`,
    `<div class="mini-card"><strong>Closed loop alert</strong><br><span class="${pine.hasClosedLoopAlert ? 'good' : 'bad'}">${pine.hasClosedLoopAlert ? 'Enabled' : 'Missing'}</span></div>`,
    `<div class="mini-card"><strong>Default mode</strong><br><span class="muted">${pine.defaultMode || 'unknown'}</span></div>`,
    `<div class="mini-card"><strong>Updated</strong><br><span class="muted">${pine.updatedAt ? new Date(pine.updatedAt).toLocaleString() : 'n/a'}</span></div>`,
    `<div class="mini-card"><strong>Modes</strong><br><span class="muted">${(pine.modeOptions || []).join(', ')}</span></div>`,
  ].join('');
}

function renderCandidates(data) {
  const candidates = data.patternCandidates || [];
  document.getElementById('candidateTable').innerHTML = candidates.slice(0, 80).map((candidate) => row([
    `<strong>${candidate.id}</strong>`,
    candidate.status,
    candidate.symbol,
    candidate.triggerMode,
    num(candidate.metrics.trades),
    pct(candidate.metrics.winRate),
    `<span class="${colorForNet(candidate.metrics.netDollars)}">${money(candidate.metrics.netDollars)}</span>`,
    `${candidate.suggestedRules?.targetR || 'n/a'}R`,
    (candidate.preferredTags || []).slice(0, 3).join(', '),
  ])).join('') || row(['No candidates yet', '', '', '', '', '', '', '', '']);
}

function renderFactory(data) {
  const candidates = data.specialistFactory || data.canonical?.factoryCandidates || [];
  document.getElementById('factoryTable').innerHTML = candidates.slice(0, 100).map((candidate) => row([
    `<strong>${candidate.id}</strong><br><span class="muted">${candidate.family}</span>`,
    candidate.status,
    `${candidate.symbol} · ${candidate.triggerMode}<br><span class="muted">${candidate.session} · ${candidate.side}</span>`,
    num(candidate.metrics?.trades || 0),
    pct(candidate.metrics?.winRate || 0),
    `<span class="${colorForNet(candidate.metrics?.netDollars)}">${money(candidate.metrics?.netDollars)}</span>`,
    `<span class="${colorForQuality(candidate.qualityScore)}">${Number(candidate.qualityScore || 0).toFixed(1)}</span>`,
    `${num(candidate.consistency?.uniqueDays || 0)}d / ${num(candidate.consistency?.uniqueWeeks || 0)}w`,
    `${candidate.suggestedRules?.targetR || 'n/a'}R`,
    (candidate.featureBoosts || []).slice(0, 3).map((edge) => `${edge.feature} +${edge.edge}`).join(', ') || 'n/a',
  ])).join('') || row(['No factory candidates yet', '', '', '', '', '', '', '', '', '']);
}

function renderPhase22(data) {
  const phase22 = data.phase22;
  const champion = phase22?.recommendedChampion;
  document.getElementById('phase22Badge').textContent = phase22?.updatedAt
    ? `Updated ${new Date(phase22.updatedAt).toLocaleString()}`
    : 'No Phase22 run yet';
  document.getElementById('phase22Metrics').innerHTML = champion ? [
    metric('Configs Tested', num(phase22.config?.variantsEvaluated || 0)),
    metric('Trades', num(champion.metrics?.trades || 0)),
    metric('Win Rate', pct(champion.metrics?.winRate || 0), champion.metrics?.winRate >= 80 ? 'good' : 'warn'),
    metric('Net', money(champion.metrics?.netDollars || 0), colorForNet(champion.metrics?.netDollars)),
    metric('Avg / Trade', money(champion.metrics?.avgDollars || 0), colorForNet(champion.metrics?.avgDollars)),
    metric('Holdout Win', pct(champion.holdout?.winRate || 0), champion.holdout?.winRate >= 80 ? 'good' : 'warn'),
    metric('Stress Net', money(champion.stress?.netDollars || 0), colorForNet(champion.stress?.netDollars)),
    metric('Routes', num(champion.routeCount || 0)),
    metric('Max DD', money(champion.metrics?.maxDrawdownDollars || 0), 'warn'),
    metric('Loss Streak', num(champion.metrics?.maxLossStreak || 0)),
    metric('MC P05 Net', money(champion.monteCarlo?.p05NetDollars || 0), colorForNet(champion.monteCarlo?.p05NetDollars)),
    metric('MC P95 DD', money(champion.monteCarlo?.p95MaxDrawdownDollars || 0), 'warn'),
  ].join('') : '<p class="muted">Run `npm run scalp:phase22` to build the deep tournament.</p>';

  const categories = Object.entries(phase22?.categoryChampions || {}).filter(([, variant]) => variant);
  document.getElementById('phase22CategoryTable').innerHTML = categories.map(([name, variant]) => row([
    name,
    `<strong>${variant.profile}</strong><br><span class="muted">${variant.universe} · ${variant.sessionGroup} · ${variant.triggerGroup}</span>`,
    num(variant.metrics?.trades || 0),
    pct(variant.metrics?.winRate || 0),
    `<span class="${colorForNet(variant.metrics?.netDollars)}">${money(variant.metrics?.netDollars)}</span>`,
    `${num(variant.holdout?.trades || 0)} / ${pct(variant.holdout?.winRate || 0)}`,
    `<span class="${colorForNet(variant.stress?.netDollars)}">${money(variant.stress?.netDollars)}</span>`,
  ])).join('') || row(['No Phase22 categories yet', '', '', '', '', '', '']);

  document.getElementById('phase22TopRoutes').innerHTML = (champion?.topRoutes || []).slice(0, 8).map((route) => `
    <div class="mini-card">
      <strong>${route.symbol} · ${route.trigger} · ${route.side}</strong>
      <p class="muted">${route.family} · ${route.session} · route score ${Number(route.routeScore || 0).toFixed(1)} · quality ${Number(route.qualityScore || 0).toFixed(1)}</p>
      <p class="muted">${num(route.metrics?.trades || 0)} trades · ${pct(route.metrics?.winRate || 0)} win · <span class="${colorForNet(route.metrics?.netDollars)}">${money(route.metrics?.netDollars)}</span></p>
    </div>
  `).join('') || '<p class="muted">No Phase22 routes yet.</p>';
}

function renderDaily(data) {
  const daily = data.patternLab?.dailyPerformance || [];
  document.getElementById('dailyTable').innerHTML = daily.slice(-120).reverse().map((item) => row([
    item.date,
    item.specialist,
    item.family,
    num(item.metrics.trades),
    pct(item.metrics.winRate),
    `<span class="${colorForNet(item.metrics.netDollars)}">${money(item.metrics.netDollars)}</span>`,
    money(item.metrics.avgDollars),
    Number(item.metrics.profitFactor || 0).toFixed(2),
  ])).join('') || row(['No daily data yet', '', '', '', '', '', '', '']);
}

function renderForward(data) {
  const forward = data.forward || {};
  const metrics = forward.latestPhase18?.metrics || {};
  const routes = forward.topRouteTrust || [];
  document.getElementById('forwardStatus').innerHTML = [
    `<div class="mini-card"><strong>Phase18 mature signals</strong><br><span class="muted">${num(metrics.trades)} trades · ${pct(metrics.winRate)} win · ${money(metrics.netDollars)} net</span></div>`,
    `<div class="mini-card"><strong>Route trust updated</strong><br><span class="muted">${forward.routeTrustUpdatedAt ? new Date(forward.routeTrustUpdatedAt).toLocaleString() : 'n/a'}</span></div>`,
    `<div class="mini-card"><strong>Top forward routes</strong><br><span class="muted">${routes.slice(0, 5).map((route) => `${route.symbol || ''} ${route.triggerMode || ''}: ${pct(route.winRate)} / ${money(route.netDollars)}`).join('<br>') || 'No forward route trust yet'}</span></div>`,
  ].join('');
}

loadDashboard()
  .then((data) => {
    renderSummary(data);
    renderCanonical(data);
    renderChampion(data);
    renderSpecialists(data);
    renderSpecialistCards(data);
    renderTopHits(data);
    renderPatterns(data);
    renderPine(data);
    renderCandidates(data);
    renderFactory(data);
    renderPhase22(data);
    renderDaily(data);
    renderForward(data);
  })
  .catch((error) => {
    document.body.innerHTML = `<main><section class="panel"><h1>Dashboard failed to load</h1><p>${error.message}</p></section></main>`;
  });
