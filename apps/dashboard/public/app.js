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
  const data = await response.json();
  try {
    const tradeResponse = await fetch('./data/phase22-trade-ledgers.json', { cache: 'no-store' });
    data.phase22TradeLedgers = tradeResponse.ok ? await tradeResponse.json() : null;
  } catch {
    data.phase22TradeLedgers = null;
  }
  try {
    const phase23TradeResponse = await fetch('./data/phase23-intelligence-trade-ledgers.json', { cache: 'no-store' });
    data.phase23TradeLedgers = phase23TradeResponse.ok ? await phase23TradeResponse.json() : null;
  } catch {
    data.phase23TradeLedgers = null;
  }
  try {
    const phase24TradeResponse = await fetch('./data/phase24-trade-ledgers.json', { cache: 'no-store' });
    data.phase24TradeLedgers = phase24TradeResponse.ok ? await phase24TradeResponse.json() : null;
  } catch {
    data.phase24TradeLedgers = null;
  }
  try {
    const phase25TradeResponse = await fetch('./data/phase25-fresh-symbol-trade-ledgers.json', { cache: 'no-store' });
    data.phase25TradeLedgers = phase25TradeResponse.ok ? await phase25TradeResponse.json() : null;
  } catch {
    data.phase25TradeLedgers = null;
  }
  return data;
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

function ledgerLabel(category, ledger) {
  return `${category} · ${ledger.profile} · ${num(ledger.metrics?.trades || ledger.trades?.length || 0)} trades · ${pct(ledger.metrics?.winRate || 0)} · ${money(ledger.metrics?.netDollars || 0)}`;
}

function renderPhase22TradeLedger(data) {
  const payload = data.phase22TradeLedgers;
  const select = document.getElementById('phase22TradeLedgerSelect');
  const search = document.getElementById('phase22TradeSearch');
  const table = document.getElementById('phase22TradeTable');
  const count = document.getElementById('phase22TradeCount');
  const metricsEl = document.getElementById('phase22TradeMetrics');

  if (!payload?.ledgers || !Object.keys(payload.ledgers).length) {
    count.textContent = 'No trade ledger yet';
    metricsEl.innerHTML = '<p class="muted">Run `npm run scalp:phase22` to export exact trade ledgers.</p>';
    table.innerHTML = row(['No Phase22 trades yet', '', '', '', '', '', '', '', '', '', '', '']);
    return;
  }

  const categories = Object.entries(payload.categoryMap || {}).filter(([, id]) => payload.ledgers[id]);
  select.innerHTML = categories.map(([category, id]) => {
    const ledger = payload.ledgers[id];
    return `<option value="${category}">${ledgerLabel(category, ledger)}</option>`;
  }).join('');
  if ([...select.options].some((option) => option.value === 'mainMinimum150')) {
    select.value = 'mainMinimum150';
  }

  function draw() {
    const category = select.value || categories[0]?.[0];
    const id = payload.categoryMap?.[category] || categories[0]?.[1];
    const ledger = payload.ledgers[id];
    const query = (search.value || '').trim().toLowerCase();
    const trades = (ledger?.trades || []).filter((trade) => {
      if (!query) return true;
      return [
        trade.symbol,
        trade.family,
        trade.side,
        trade.trigger,
        trade.session,
        trade.selectedRouteKey,
        trade.outcome,
        ...(trade.tags || []),
      ].join(' ').toLowerCase().includes(query);
    });

    count.textContent = `${num(trades.length)} shown / ${num(ledger?.trades?.length || 0)} trades`;
    metricsEl.innerHTML = [
      metric('Winner', category),
      metric('Trades', num(ledger?.metrics?.trades || 0)),
      metric('Win Rate', pct(ledger?.metrics?.winRate || 0), ledger?.metrics?.winRate >= 80 ? 'good' : 'warn'),
      metric('Net', money(ledger?.metrics?.netDollars || 0), colorForNet(ledger?.metrics?.netDollars)),
      metric('Avg / Trade', money(ledger?.metrics?.avgDollars || 0), colorForNet(ledger?.metrics?.avgDollars)),
      metric('Holdout Win', pct(ledger?.holdout?.winRate || 0), ledger?.holdout?.winRate >= 80 ? 'good' : 'warn'),
      metric('Stress Net', money(ledger?.stress?.netDollars || 0), colorForNet(ledger?.stress?.netDollars)),
      metric('Routes', num(ledger?.routeCount || 0)),
    ].join('');

    table.innerHTML = trades.map((trade) => row([
      trade.index,
      trade.date,
      `<strong>${trade.symbol}</strong><br><span class="muted">${trade.family}</span>`,
      `${trade.side}<br><span class="muted">${trade.trigger} · ${trade.session}</span>`,
      `${shortTime(trade.entryTime)}<br><span class="muted">→ ${shortTime(trade.exitTime)}</span>`,
      trade.minutesHeld === null || trade.minutesHeld === undefined ? 'n/a' : `${trade.minutesHeld}m`,
      `${price(trade.entry)}<br><span class="muted">→ ${price(trade.exit)}</span>`,
      `<span class="${colorForNet(trade.pnlDollars)}">${money(trade.pnlDollars)}</span><br><span class="muted">${trade.outcome}</span>`,
      `<span class="${colorForNet(trade.modeledPnlScaledTo10k)}">${money(trade.modeledPnlScaledTo10k)}</span>`,
      `${Number(trade.mfeR || 0).toFixed(2)}R / ${Number(trade.maeR || 0).toFixed(2)}R`,
      trade.confidence || 0,
      `<span class="muted">${trade.selectedRouteKey || 'n/a'}</span>`,
    ])).join('') || row(['No matching trades', '', '', '', '', '', '', '', '', '', '', '']);
  }

  select.onchange = draw;
  search.oninput = draw;
  draw();
}

function renderPhase23(data) {
  const phase23 = data.phase23;
  const champion = phase23?.recommendedChampion;
  const elite = phase23?.categoryChampions?.elitePrecision;
  const guarded = phase23?.categoryChampions?.highWinGuarded;
  document.getElementById('phase23Badge').textContent = phase23?.updatedAt
    ? `Updated ${new Date(phase23.updatedAt).toLocaleString()}`
    : 'No Phase23 run yet';
  document.getElementById('phase23Metrics').innerHTML = champion ? [
    metric('Variants Kept', num(phase23.config?.variantsKept || 0)),
    metric('Balanced Trades', num(champion.metrics?.trades || 0)),
    metric('Balanced Win', pct(champion.metrics?.winRate || 0), champion.metrics?.winRate >= 90 ? 'good' : 'warn'),
    metric('Balanced Net', money(champion.metrics?.netDollars || 0), colorForNet(champion.metrics?.netDollars)),
    metric('High-Win Guard', guarded ? pct(guarded.metrics?.winRate || 0) : 'n/a', 'good'),
    metric('Elite Precision', elite ? pct(elite.metrics?.winRate || 0) : 'n/a', 'good'),
    metric('Elite Trades', num(elite?.metrics?.trades || 0)),
    metric('Elite Net', money(elite?.metrics?.netDollars || 0), colorForNet(elite?.metrics?.netDollars)),
    metric('Baseline P22 Win', pct(phase23.baselinePhase22?.metrics?.winRate || 0)),
    metric('Baseline P22 Net', money(phase23.baselinePhase22?.metrics?.netDollars || 0), colorForNet(phase23.baselinePhase22?.metrics?.netDollars)),
    metric('Feature Groups', num(Object.keys(phase23.featureBlueprints || {}).length)),
    metric('ML Draft', phase23.machineLearningDraft?.status || 'n/a'),
  ].join('') : '<p class="muted">Run `npm run scalp:phase23` to build the intelligence layer.</p>';

  const categories = Object.entries(phase23?.categoryChampions || {}).filter(([, variant]) => variant);
  document.getElementById('phase23CategoryTable').innerHTML = categories.map(([name, variant]) => {
    const guards = variant.diagnostics?.guards?.map((guard) => `${guard.feature} ${guard.op} ${guard.value}`).join('<br>') || `score ≥ ${variant.threshold ?? 'n/a'}`;
    return row([
      `<strong>${name}</strong><br><span class="muted">${variant.profile}</span>`,
      `<span class="muted">${variant.goal || 'n/a'}</span>`,
      num(variant.metrics?.trades || 0),
      pct(variant.metrics?.winRate || 0),
      `<span class="${colorForNet(variant.metrics?.netDollars)}">${money(variant.metrics?.netDollars)}</span>`,
      `${num(variant.holdout?.trades || 0)} / ${pct(variant.holdout?.winRate || 0)}`,
      `<span class="muted">${guards}</span>`,
    ]);
  }).join('') || row(['No Phase23 categories yet', '', '', '', '', '', '']);

  const blueprints = Object.entries(phase23?.featureBlueprints || {});
  document.getElementById('phase23FeatureCards').innerHTML = blueprints.slice(0, 10).map(([name, blueprint]) => `
    <div class="mini-card">
      <strong>${name}</strong>
      <p class="muted">${blueprint.description}</p>
      <p class="muted">Weights: ${Object.entries(blueprint.weights || {}).slice(0, 6).map(([feature, weight]) => `${feature} ${Number(weight).toFixed(2)}`).join(', ')}</p>
    </div>
  `).join('') || '<p class="muted">No Phase23 feature cards yet.</p>';
}

function renderPhase24(data) {
  const phase24 = data.phase24;
  const bestProfit = phase24?.categoryChampions?.bestProfit;
  const bestHighWin = phase24?.categoryChampions?.bestHighWin;
  const bestOptions = phase24?.categoryChampions?.bestOptions;
  document.getElementById('phase24Badge').textContent = phase24?.updatedAt
    ? `Updated ${new Date(phase24.updatedAt).toLocaleString()}`
    : 'No Phase24 run yet';
  document.getElementById('phase24Metrics').innerHTML = phase24 ? [
    metric('Evaluated', num(phase24.config?.evaluated || 0)),
    metric('Kept Variants', num(phase24.config?.kept || 0)),
    metric('Pools', num(phase24.config?.pools || 0)),
    metric('Promoted', num((phase24.promoted || []).length), (phase24.promoted || []).length ? 'good' : 'warn'),
    metric('Best Profit Trades', num(bestProfit?.metrics?.trades || 0)),
    metric('Best Profit Net', money(bestProfit?.metrics?.netDollars || 0), colorForNet(bestProfit?.metrics?.netDollars)),
    metric('Best Profit Win', pct(bestProfit?.metrics?.winRate || 0), bestProfit?.metrics?.winRate >= 80 ? 'good' : 'warn'),
    metric('Best High-Win', pct(bestHighWin?.metrics?.winRate || 0), bestHighWin?.metrics?.winRate >= 90 ? 'good' : 'warn'),
    metric('Options Worthy', pct(bestOptions?.metrics?.optionWorthyRate || 0)),
    metric('Options Trades', num((phase24.optionsWorthyTrades || []).length)),
    metric('Paper Only', phase24.safety?.paperOnly ? 'Yes' : 'Unknown', phase24.safety?.paperOnly ? 'good' : 'warn'),
    metric('No Broker Orders', phase24.safety?.noBrokerOrders ? 'Yes' : 'Unknown', phase24.safety?.noBrokerOrders ? 'good' : 'warn'),
  ].join('') : '<p class="muted">Run `npm run lab:self-improve` to build the Phase24 loop.</p>';

  const categories = Object.entries(phase24?.categoryChampions || {}).filter(([, variant]) => variant);
  document.getElementById('phase24CategoryTable').innerHTML = categories.map(([name, variant]) => row([
    `<strong>${name}</strong><br><span class="muted">${variant.id}</span>`,
    `${variant.profile}<br><span class="muted">${variant.poolLabel || variant.poolId} · ${variant.direction} · ${variant.sessionGroup}</span>`,
    num(variant.metrics?.trades || 0),
    pct(variant.metrics?.winRate || 0),
    `<span class="${colorForNet(variant.metrics?.netDollars)}">${money(variant.metrics?.netDollars)}</span>`,
    `${num(variant.holdout?.trades || 0)} / ${pct(variant.holdout?.winRate || 0)}`,
    `<strong>${variant.decision || 'n/a'}</strong><br><span class="muted">${(variant.decisionReasons || []).slice(0, 2).join('<br>')}</span>`,
  ])).join('') || row(['No Phase24 categories yet', '', '', '', '', '', '']);

  document.getElementById('phase24LoopCards').innerHTML = [
    ...(phase24?.improvementLoop || []).map((item, index) => `
      <div class="mini-card"><strong>Step ${index + 1}</strong><p class="muted">${item}</p></div>
    `),
    `<div class="mini-card"><strong>Top Options-Worthy</strong><p class="muted">${(phase24?.optionsWorthyTrades || []).slice(0, 5).map((trade) => `${trade.symbol}: ${money(trade.estimatedBestOption?.oracleProfitOn10k || 0)} est. oracle / 10k`).join('<br>') || 'No option candidates yet'}</p></div>`,
  ].join('');
}

function renderPhase24TradeLedger(data) {
  const payload = data.phase24TradeLedgers;
  const select = document.getElementById('phase24TradeLedgerSelect');
  const search = document.getElementById('phase24TradeSearch');
  const table = document.getElementById('phase24TradeTable');
  const count = document.getElementById('phase24TradeCount');
  const metricsEl = document.getElementById('phase24TradeMetrics');

  if (!payload?.ledgers || !Object.keys(payload.ledgers).length) {
    count.textContent = 'No trade ledger yet';
    metricsEl.innerHTML = '<p class="muted">Run `npm run lab:self-improve` to export exact Phase24 ledgers.</p>';
    table.innerHTML = row(['No Phase24 trades yet', '', '', '', '', '', '', '', '', '', '', '']);
    return;
  }

  const categories = Object.entries(payload.categoryMap || {}).filter(([, id]) => payload.ledgers[id]);
  select.innerHTML = categories.map(([category, id]) => {
    const ledger = payload.ledgers[id];
    return `<option value="${category}">${ledgerLabel(category, ledger)}</option>`;
  }).join('');
  if ([...select.options].some((option) => option.value === 'bestProfit')) select.value = 'bestProfit';

  function draw() {
    const category = select.value || categories[0]?.[0];
    const id = payload.categoryMap?.[category] || categories[0]?.[1];
    const ledger = payload.ledgers[id];
    const query = (search.value || '').trim().toLowerCase();
    const trades = (ledger?.trades || []).filter((trade) => {
      if (!query) return true;
      return [
        trade.symbol,
        trade.family,
        trade.side,
        trade.trigger,
        trade.session,
        trade.selectedRouteKey,
        trade.outcome,
        ...(trade.tags || []),
        trade.overnight ? 'overnight' : 'intraday',
      ].join(' ').toLowerCase().includes(query);
    });

    count.textContent = `${num(trades.length)} shown / ${num(ledger?.trades?.length || 0)} trades`;
    metricsEl.innerHTML = [
      metric('Winner', category),
      metric('Trades', num(ledger?.metrics?.trades || 0)),
      metric('Win Rate', pct(ledger?.metrics?.winRate || 0), ledger?.metrics?.winRate >= 80 ? 'good' : 'warn'),
      metric('Net', money(ledger?.metrics?.netDollars || 0), colorForNet(ledger?.metrics?.netDollars)),
      metric('Avg / Trade', money(ledger?.metrics?.avgDollars || 0), colorForNet(ledger?.metrics?.avgDollars)),
      metric('Holdout Win', pct(ledger?.holdout?.winRate || 0), ledger?.holdout?.winRate >= 80 ? 'good' : 'warn'),
      metric('Stress Net', money(ledger?.stress?.netDollars || 0), colorForNet(ledger?.stress?.netDollars)),
      metric('Decision', ledger?.decision || 'n/a'),
    ].join('');

    table.innerHTML = trades.map((trade) => row([
      trade.index,
      trade.date,
      `<strong>${trade.symbol}</strong><br><span class="muted">${trade.family}</span>`,
      `${trade.side}<br><span class="muted">${trade.trigger} · ${trade.session}</span>`,
      `${shortTime(trade.entryTime)}<br><span class="muted">→ ${shortTime(trade.exitTime)}</span>`,
      trade.minutesHeld === null || trade.minutesHeld === undefined ? 'n/a' : `${trade.minutesHeld}m${trade.overnight ? ' · ON' : ''}`,
      `${price(trade.entry)}<br><span class="muted">→ ${price(trade.exit)}</span>`,
      `<span class="${colorForNet(trade.pnlDollars)}">${money(trade.pnlDollars)}</span><br><span class="muted">${trade.outcome}</span>`,
      `<span class="${colorForNet(trade.modeledPnlScaledTo10k)}">${money(trade.modeledPnlScaledTo10k)}</span>`,
      `${Number(trade.mfeR || 0).toFixed(2)}R / ${Number(trade.maeR || 0).toFixed(2)}R`,
      `${Number(trade.phase24Score || 0).toFixed(3)}<br><span class="muted">conf ${trade.confidence || 0}</span>`,
      `<span class="muted">${trade.selectedRouteKey || 'n/a'}</span>`,
    ])).join('') || row(['No matching trades', '', '', '', '', '', '', '', '', '', '', '']);
  }

  select.onchange = draw;
  search.oninput = draw;
  draw();
}

function renderPhase25(data) {
  const phase25 = data.phase25;
  const bestOverall = phase25?.categoryChampions?.bestOverall;
  const bestProfit = phase25?.categoryChampions?.bestProfit;
  const bestHighWin = phase25?.categoryChampions?.bestHighWin;
  document.getElementById('phase25Badge').textContent = phase25?.updatedAt
    ? `Updated ${new Date(phase25.updatedAt).toLocaleString()}`
    : 'No Phase25 run yet';
  document.getElementById('phase25Metrics').innerHTML = phase25 ? [
    metric('Fresh Symbols', num(phase25.config?.freshSymbols || 0), 'good'),
    metric('Fresh Trades', num(phase25.config?.freshTrades || 0), 'good'),
    metric('Excluded Prior Symbols', num(phase25.config?.excludedSymbols || 0)),
    metric('Challengers', num(phase25.config?.challengerCount || 0)),
    metric('Evaluated', num(phase25.config?.evaluated || 0)),
    metric('Kept Low-Floor', num(phase25.config?.kept || 0)),
    metric('Qualified', num(phase25.config?.qualified || 0)),
    metric('Promoted', num((phase25.promoted || []).length), (phase25.promoted || []).length ? 'good' : 'warn'),
    metric('Best Overall Win', pct(bestOverall?.metrics?.winRate || 0), bestOverall?.metrics?.winRate >= 80 ? 'good' : 'warn'),
    metric('Best Overall Net', money(bestOverall?.metrics?.netDollars || 0), colorForNet(bestOverall?.metrics?.netDollars)),
    metric('Best Profit Net', money(bestProfit?.metrics?.netDollars || 0), colorForNet(bestProfit?.metrics?.netDollars)),
    metric('Best High-Win', pct(bestHighWin?.metrics?.winRate || 0), bestHighWin?.metrics?.winRate >= 80 ? 'good' : 'warn'),
    metric('Min Trade Floor', num(phase25.config?.minTrades || 0)),
  ].join('') : '<p class="muted">Run `npm run lab:phase25` to test fresh symbols excluded from prior champions.</p>';

  const categories = Object.entries(phase25?.categoryChampions || {}).filter(([, variant]) => variant);
  document.getElementById('phase25CategoryTable').innerHTML = categories.map(([name, variant]) => row([
    `<strong>${name}</strong><br><span class="muted">${variant.challenger || variant.id}</span>`,
    `${variant.description || 'n/a'}<br><span class="muted">target ${variant.targetR ?? 'n/a'}R · q ${variant.threshold ?? 'n/a'}</span>`,
    num(variant.metrics?.trades || 0),
    pct(variant.metrics?.winRate || 0),
    `<span class="${colorForNet(variant.metrics?.netDollars)}">${money(variant.metrics?.netDollars)}</span>`,
    `${num(variant.holdout?.trades || 0)} / ${pct(variant.holdout?.winRate || 0)}`,
    `<strong>${variant.decision || 'n/a'}</strong><br><span class="muted">${(variant.decisionReasons || []).slice(0, 2).join('<br>')}</span>`,
  ])).join('') || row(['No Phase25 categories yet', '', '', '', '', '', '']);

  document.getElementById('phase25ChallengerTable').innerHTML = (phase25?.perChallengerBest || []).slice(0, 30).map((variant) => row([
    `<strong>${variant.challenger || variant.uniqueTwist}</strong>`,
    variant.description || 'n/a',
    num(variant.metrics?.trades || 0),
    pct(variant.metrics?.winRate || 0),
    `<span class="${colorForNet(variant.metrics?.netDollars)}">${money(variant.metrics?.netDollars)}</span>`,
    `${num(variant.holdout?.trades || 0)} / ${pct(variant.holdout?.winRate || 0)}`,
    `<span class="muted">${variant.decision || 'n/a'}</span>`,
  ])).join('') || row(['No Phase25 challengers yet', '', '', '', '', '', '']);

  document.getElementById('phase25FreshSymbolTable').innerHTML = (phase25?.freshSymbolLeaderboard || []).slice(0, 20).map((item) => row([
    `<strong>${item.symbol}</strong><br><span class="muted">${item.family || 'n/a'}</span>`,
    num(item.trades || 0),
    pct(item.winRate || 0),
    `<span class="${colorForNet(item.netDollars)}">${money(item.netDollars)}</span>`,
  ])).join('') || row(['No fresh symbol leaderboard yet', '', '', '']);
}

function renderPhase25TradeLedger(data) {
  const payload = data.phase25TradeLedgers;
  const select = document.getElementById('phase25TradeLedgerSelect');
  const search = document.getElementById('phase25TradeSearch');
  const table = document.getElementById('phase25TradeTable');
  const count = document.getElementById('phase25TradeCount');
  const metricsEl = document.getElementById('phase25TradeMetrics');

  if (!payload?.ledgers || !Object.keys(payload.ledgers).length) {
    count.textContent = 'No trade ledger yet';
    metricsEl.innerHTML = '<p class="muted">Run `npm run lab:phase25` to export exact fresh-symbol trades.</p>';
    table.innerHTML = row(['No Phase25 trades yet', '', '', '', '', '', '', '', '', '', '', '']);
    return;
  }

  const categories = Object.entries(payload.categoryMap || {}).filter(([, id]) => payload.ledgers[id]);
  select.innerHTML = categories.map(([category, id]) => {
    const ledger = payload.ledgers[id];
    return `<option value="${category}">${ledgerLabel(category, ledger)}</option>`;
  }).join('');
  if ([...select.options].some((option) => option.value === 'bestProfit')) select.value = 'bestProfit';

  function draw() {
    const category = select.value || categories[0]?.[0];
    const id = payload.categoryMap?.[category] || categories[0]?.[1];
    const ledger = payload.ledgers[id];
    const query = (search.value || '').trim().toLowerCase();
    const trades = (ledger?.trades || []).filter((trade) => {
      if (!query) return true;
      return [
        trade.symbol,
        trade.family,
        trade.side,
        trade.trigger,
        trade.session,
        trade.selectedRouteKey,
        trade.outcome,
        ...(trade.tags || []),
        trade.overnight ? 'overnight' : 'intraday',
      ].join(' ').toLowerCase().includes(query);
    });

    count.textContent = `${num(trades.length)} shown / ${num(ledger?.trades?.length || 0)} trades`;
    metricsEl.innerHTML = [
      metric('Fresh Winner', category),
      metric('Trades', num(ledger?.metrics?.trades || 0)),
      metric('Win Rate', pct(ledger?.metrics?.winRate || 0), ledger?.metrics?.winRate >= 80 ? 'good' : 'warn'),
      metric('Net', money(ledger?.metrics?.netDollars || 0), colorForNet(ledger?.metrics?.netDollars)),
      metric('Avg / Trade', money(ledger?.metrics?.avgDollars || 0), colorForNet(ledger?.metrics?.avgDollars)),
      metric('Holdout Win', pct(ledger?.holdout?.winRate || 0), ledger?.holdout?.winRate >= 80 ? 'good' : 'warn'),
      metric('Stress Net', money(ledger?.stress?.netDollars || 0), colorForNet(ledger?.stress?.netDollars)),
      metric('Decision', ledger?.decision || 'n/a'),
    ].join('');

    table.innerHTML = trades.map((trade) => row([
      trade.index,
      trade.date,
      `<strong>${trade.symbol}</strong><br><span class="muted">${trade.family}</span>`,
      `${trade.side}<br><span class="muted">${trade.trigger} · ${trade.session}</span>`,
      `${shortTime(trade.entryTime)}<br><span class="muted">→ ${shortTime(trade.exitTime)}</span>`,
      trade.minutesHeld === null || trade.minutesHeld === undefined ? 'n/a' : `${trade.minutesHeld}m${trade.overnight ? ' · ON' : ''}`,
      `${price(trade.entry)}<br><span class="muted">→ ${price(trade.exit)}</span>`,
      `<span class="${colorForNet(trade.pnlDollars)}">${money(trade.pnlDollars)}</span><br><span class="muted">${trade.outcome}</span>`,
      `<span class="${colorForNet(trade.modeledPnlScaledTo10k)}">${money(trade.modeledPnlScaledTo10k)}</span>`,
      `${Number(trade.mfeR || 0).toFixed(2)}R / ${Number(trade.maeR || 0).toFixed(2)}R`,
      `${Number(trade.phase25Score || 0).toFixed(3)}<br><span class="muted">conf ${trade.confidence || 0}</span>`,
      `<span class="muted">${trade.selectedRouteKey || 'n/a'}</span>`,
    ])).join('') || row(['No matching trades', '', '', '', '', '', '', '', '', '', '', '']);
  }

  select.onchange = draw;
  search.oninput = draw;
  draw();
}

function renderOptionsProbe(data) {
  const probe = data.optionsProbe;
  document.getElementById('optionsProbeBadge').textContent = probe?.updatedAt
    ? `Updated ${new Date(probe.updatedAt).toLocaleString()}`
    : 'No options probe yet';
  document.getElementById('optionsProbeMetrics').innerHTML = probe ? [
    metric('Source', `${probe.sourceLedger?.phase}:${probe.sourceLedger?.category}`),
    metric('Trades Tested', num(probe.totals?.trades || 0)),
    metric('Equity 10k PnL', money(probe.totals?.equityPnlOn10k || 0), colorForNet(probe.totals?.equityPnlOn10k)),
    metric('Est. System Option 10k', money(probe.totals?.estimatedSystemExitOptionProfitOn10k || 0), colorForNet(probe.totals?.estimatedSystemExitOptionProfitOn10k)),
    metric('Est. Oracle Option 10k', money(probe.totals?.estimatedOracleOptionProfitOn10k || 0), colorForNet(probe.totals?.estimatedOracleOptionProfitOn10k)),
    metric('Historical Contracts', probe.dataConfidence?.exactHistoricalContracts || 'n/a'),
    metric('Current Chains', probe.dataConfidence?.currentChains || 'n/a'),
    metric('Mode', probe.dataConfidence?.estimatedBacktest || 'n/a'),
  ].join('') : '<p class="muted">Run `npm run options:probe` to test free/estimated options data.</p>';

  document.getElementById('optionsProbeTable').innerHTML = (probe?.rows || []).slice(0, 30).map((item) => {
    const oracle = item.estimatedBestOracle || {};
    const system = item.estimatedBestAtSystemExit || {};
    return row([
      `<strong>${item.symbol}</strong><br><span class="muted">${item.optionSide}</span>`,
      `${item.side} @ ${price(item.entry)} → ${price(item.exit)}<br><span class="muted">${money(item.equityPnlOn10k)} equity / 10k</span>`,
      `${oracle.contractType || item.optionSide} ${price(oracle.strike)} · ${oracle.dte ?? 'n/a'} DTE<br><span class="muted">entry ${price(oracle.entryPremium)}</span>`,
      `${money(system.profitOn10k || 0)}<br><span class="muted">${Number(system.roiPct || 0).toFixed(0)}%</span>`,
      `${money(oracle.oracleProfitOn10k || 0)}<br><span class="muted">${Number(oracle.oracleRoiPct || 0).toFixed(0)}%</span>`,
      `<span class="muted">${oracle.dataConfidence || 'Estimated'}</span>`,
    ]);
  }).join('') || row(['No option rows yet', '', '', '', '', '']);

  document.getElementById('optionsProviderCards').innerHTML = (probe?.providerResults || []).map((item) => `
    <div class="mini-card">
      <strong>${item.provider}</strong>
      <p class="muted">${item.symbol || ''} · ${item.status}</p>
      <p class="muted">${item.note || item.message || item.error || ''}</p>
    </div>
  `).join('') || '<p class="muted">No provider probes yet.</p>';
}

function renderTradingViewMcp(data) {
  const tv = data.tradingViewMcp;
  document.getElementById('tradingViewMcpBadge').textContent = tv?.updatedAt
    ? `Updated ${new Date(tv.updatedAt).toLocaleString()}`
    : 'No MCP snapshot yet';
  document.getElementById('tradingViewMcpMetrics').innerHTML = tv ? [
    metric('Quote Symbol', tv.quote?.symbol || 'n/a'),
    metric('Last', price(tv.quote?.last || tv.quote?.close || 0)),
    metric('Volume', num(tv.quote?.volume || 0)),
    metric('Bars Checked', num(tv.ohlcvSummary?.bar_count || 0)),
    metric('100-Bar Change', tv.ohlcvSummary?.change_pct || 'n/a', Number(tv.ohlcvSummary?.change || 0) >= 0 ? 'good' : 'bad'),
    metric('Read Only', tv.safety?.noBrokerOrders ? 'No orders' : 'Unknown', tv.safety?.noBrokerOrders ? 'good' : 'warn'),
  ].join('') : '<p class="muted">Use TradingView MCP quote/OHLCV tools to refresh this snapshot.</p>';
  document.getElementById('tradingViewMcpNotes').innerHTML = tv ? [
    `<div class="mini-card"><strong>Capabilities</strong><p class="muted">${(tv.capabilitiesVerified || []).join(', ') || 'n/a'}</p></div>`,
    `<div class="mini-card"><strong>Limits</strong><p class="muted">${(tv.limitations || []).join('<br>') || 'n/a'}</p></div>`,
  ].join('') : '';
}

function topPhase23Engines(trade) {
  return Object.entries(trade.phase23Engines || {})
    .sort(([, a], [, b]) => Number(b || 0) - Number(a || 0))
    .slice(0, 3)
    .map(([name, value]) => `${name}: ${Number(value || 0).toFixed(2)}`)
    .join('<br>') || 'n/a';
}

function renderPhase23TradeLedger(data) {
  const payload = data.phase23TradeLedgers;
  const select = document.getElementById('phase23TradeLedgerSelect');
  const search = document.getElementById('phase23TradeSearch');
  const table = document.getElementById('phase23TradeTable');
  const count = document.getElementById('phase23TradeCount');
  const metricsEl = document.getElementById('phase23TradeMetrics');

  if (!payload?.ledgers || !Object.keys(payload.ledgers).length) {
    count.textContent = 'No trade ledger yet';
    metricsEl.innerHTML = '<p class="muted">Run `npm run scalp:phase23` to export exact Phase23 intelligence trades.</p>';
    table.innerHTML = row(['No Phase23 trades yet', '', '', '', '', '', '', '', '', '', '', '']);
    return;
  }

  const categories = Object.entries(payload.categoryMap || {}).filter(([, id]) => payload.ledgers[id]);
  select.innerHTML = categories.map(([category, id]) => {
    const ledger = payload.ledgers[id];
    return `<option value="${category}">${ledgerLabel(category, ledger)}</option>`;
  }).join('');
  if ([...select.options].some((option) => option.value === 'elitePrecision')) {
    select.value = 'elitePrecision';
  }

  function draw() {
    const category = select.value || categories[0]?.[0];
    const id = payload.categoryMap?.[category] || categories[0]?.[1];
    const ledger = payload.ledgers[id];
    const query = (search.value || '').trim().toLowerCase();
    const trades = (ledger?.trades || []).filter((trade) => {
      if (!query) return true;
      return [
        trade.symbol,
        trade.family,
        trade.side,
        trade.trigger,
        trade.session,
        trade.selectedRouteKey,
        trade.outcome,
        ...Object.keys(trade.phase23Engines || {}),
      ].join(' ').toLowerCase().includes(query);
    });

    count.textContent = `${num(trades.length)} shown / ${num(ledger?.trades?.length || 0)} trades`;
    metricsEl.innerHTML = [
      metric('Overlay', category),
      metric('Trades', num(ledger?.metrics?.trades || 0)),
      metric('Win Rate', pct(ledger?.metrics?.winRate || 0), ledger?.metrics?.winRate >= 90 ? 'good' : 'warn'),
      metric('Net', money(ledger?.metrics?.netDollars || 0), colorForNet(ledger?.metrics?.netDollars)),
      metric('Avg / Trade', money(ledger?.metrics?.avgDollars || 0), colorForNet(ledger?.metrics?.avgDollars)),
      metric('Holdout Win', pct(ledger?.holdout?.winRate || 0), ledger?.holdout?.winRate >= 90 ? 'good' : 'warn'),
      metric('Stress Net', money(ledger?.stress?.netDollars || 0), colorForNet(ledger?.stress?.netDollars)),
      metric('Avg MFE / MAE', `${Number(ledger?.metrics?.avgMfeR || 0).toFixed(2)}R / ${Number(ledger?.metrics?.avgMaeR || 0).toFixed(2)}R`),
    ].join('');

    table.innerHTML = trades.map((trade) => row([
      trade.index,
      trade.date,
      `<strong>${trade.symbol}</strong><br><span class="muted">${trade.family}</span>`,
      `${trade.side}<br><span class="muted">${trade.trigger} · ${trade.session}</span>`,
      `${shortTime(trade.entryTime)}<br><span class="muted">→ ${shortTime(trade.exitTime)}</span>`,
      trade.minutesHeld === null || trade.minutesHeld === undefined ? 'n/a' : `${trade.minutesHeld}m`,
      `${price(trade.entry)}<br><span class="muted">→ ${price(trade.exit)}</span>`,
      `<span class="${colorForNet(trade.pnlDollars)}">${money(trade.pnlDollars)}</span><br><span class="muted">${trade.outcome}</span>`,
      `<span class="${colorForNet(trade.modeledPnlScaledTo10k)}">${money(trade.modeledPnlScaledTo10k)}</span>`,
      `${Number(trade.mfeR || 0).toFixed(2)}R / ${Number(trade.maeR || 0).toFixed(2)}R`,
      `${Number(trade.phase23Score || 0).toFixed(3)}<br><span class="muted">conf ${trade.confidence || 0}</span>`,
      `<span class="muted">${topPhase23Engines(trade)}</span>`,
    ])).join('') || row(['No matching trades', '', '', '', '', '', '', '', '', '', '', '']);
  }

  select.onchange = draw;
  search.oninput = draw;
  draw();
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
    renderPhase23(data);
    renderPhase24(data);
    renderPhase25(data);
    renderOptionsProbe(data);
    renderTradingViewMcp(data);
    renderPhase24TradeLedger(data);
    renderPhase25TradeLedger(data);
    renderPhase23TradeLedger(data);
    renderPhase22TradeLedger(data);
    renderDaily(data);
    renderForward(data);
  })
  .catch((error) => {
    document.body.innerHTML = `<main><section class="panel"><h1>Dashboard failed to load</h1><p>${error.message}</p></section></main>`;
  });
