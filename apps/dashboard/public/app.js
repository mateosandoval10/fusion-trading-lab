const money = (value) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
}).format(Number(value || 0));

const pct = (value) => `${Number(value || 0).toFixed(2)}%`;
const num = (value) => Number(value || 0).toLocaleString();

function metric(label, value, className = '') {
  return `<div class="metric"><div class="label">${label}</div><div class="value ${className}">${value}</div></div>`;
}

function row(cells) {
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

function colorForNet(value) {
  return Number(value || 0) >= 0 ? 'good' : 'bad';
}

async function loadDashboard() {
  const response = await fetch('./data/dashboard.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`dashboard.json ${response.status}`);
  return response.json();
}

function renderSummary(data) {
  const champion = data.champion;
  const pattern = data.patternLab;
  const forward = data.forward?.latestPhase18?.metrics;
  document.getElementById('updatedAt').textContent = `Updated ${new Date(data.updatedAt).toLocaleString()}`;
  document.getElementById('summaryCards').innerHTML = [
    metric('Champion Net', money(champion?.metrics?.netDollars), colorForNet(champion?.metrics?.netDollars)),
    metric('Champion Win', pct(champion?.metrics?.winRate), 'good'),
    metric('Pattern Trades', num(pattern?.data?.trades || 0)),
    metric('Forward Net', money(forward?.netDollars || 0), colorForNet(forward?.netDollars)),
  ].join('');
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
    renderChampion(data);
    renderSpecialists(data);
    renderPatterns(data);
    renderPine(data);
    renderCandidates(data);
    renderDaily(data);
    renderForward(data);
  })
  .catch((error) => {
    document.body.innerHTML = `<main><section class="panel"><h1>Dashboard failed to load</h1><p>${error.message}</p></section></main>`;
  });
