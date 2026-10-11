const MEALS = ['lunch', 'dinner'];
const ING_COLUMNS = ['ingredient', 'category', 'long_lasting', 'package_unit', 'package_sizes', 'unit_weight_g'];
const LS = {
  settings: 'menu.settings', fridge: 'menu.fridge', prefs: 'menu.prefs',
  ingredients: 'menu.ingredients', plan: 'menu.plan', checked: 'menu.checked',
};
// Optimizer weights: waste is measured in "fractions of the smallest package".
const W = { repeatWeek: 4, repeatPast: 1.5, unknownQty: 0.3, unusedFridge: 1, noise: 0.5, restarts: 15 };

const state = {
  recipes: new Map(),
  ingredients: new Map(),
  ingredientRows: [],
  fileIngredientRows: [],
  instructions: new Map(),
  settings: { days: 3, people: 2, weeks: 1, season: 'Winter', lunch: true, dinner: true },
  fridge: {},
  prefs: {},
  plan: null,
  checked: {},
  notices: [],
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const round = (q) => (q >= 10 ? Math.round(q) : Math.round(q * 10) / 10);
const bool = (v) => /^(true|yes|1|x)$/i.test(String(v ?? '').trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  }
  return n;
}

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

function parseTsv(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

async function loadTsv(path, optional = false) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) {
    if (optional) return [];
    throw new Error(`Could not load ${path} (${res.status})`);
  }
  return parseTsv(await res.text());
}

function normQty(q, unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (u === 'kg') return [q * 1000, 'g'];
  if (u === 'l') return [q * 1000, 'ml'];
  if (u === 'cl') return [q * 10, 'ml'];
  if (u === 'tbsp') return [q * 15, 'ml'];
  if (u === 'tsp') return [q * 5, 'ml'];
  if (['', 'unit', 'units', 'pc', 'pcs', 'piece', 'pieces', 'clove', 'cloves', 'sheet', 'sheets'].includes(u)) return [q, 'unit'];
  return [q, u];
}

function fmtQty(q, unit) {
  if (unit === 'g' && q >= 1000) return `${round(q / 1000)} kg`;
  if (unit === 'ml' && q >= 1000) return `${round(q / 1000)} l`;
  if (unit === 'unit') return `${round(q)} pc${round(q) === 1 ? '' : 's'}`;
  return `${round(q)} ${unit}`;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- data model ----------
function buildIngredients() {
  state.ingredients = new Map();
  for (const r of state.ingredientRows) {
    const name = (r.ingredient || '').trim();
    if (!name) continue;
    const unit = r.package_unit ? normQty(1, r.package_unit)[1] : null;
    const factor = r.package_unit ? normQty(1, r.package_unit)[0] : 1;
    state.ingredients.set(name, {
      name,
      category: r.category || 'Other',
      longLasting: bool(r.long_lasting),
      unit,
      sizes: String(r.package_sizes || '').split(/[;,|/]/).map(num).filter((n) => n > 0).map((n) => n * factor),
      unitWeight: num(r.unit_weight_g),
    });
  }
}

function getIng(name) {
  return state.ingredients.get(name) || { name, category: 'Other', longLasting: false, unit: null, sizes: [], unitWeight: null };
}

function convert(qty, from, ing) {
  const to = ing.unit;
  if (!to) return null;
  if (from === to) return qty;
  const mass = (u) => u === 'g' || u === 'ml';
  if (mass(from) && mass(to)) return qty;
  if (from === 'unit' && mass(to)) return ing.unitWeight ? qty * ing.unitWeight : null;
  if (mass(from) && to === 'unit') return ing.unitWeight ? qty / ing.unitWeight : null;
  return null;
}

function inSeason(recipe) {
  return !recipe.seasons.length || recipe.seasons.includes(state.settings.season.toLowerCase());
}

const activeMeals = () => MEALS.filter((m) => state.settings[m]);

function pool(meal) {
  return [...state.recipes.values()]
    .filter((r) => r.meal === meal && inSeason(r) && state.prefs[r.name] !== 'no')
    .map((r) => r.name);
}

/** Total needs per ingredient, expressed in the ingredient's package unit. */
function aggregate(recipeNames, people) {
  const out = new Map();
  for (const rn of recipeNames) {
    const r = state.recipes.get(rn);
    if (!r) continue;
    const factor = people / (r.servings || 1);
    for (const it of r.items) {
      const ing = getIng(it.ingredient);
      let e = out.get(ing.name);
      if (!e) out.set(ing.name, (e = { ing, amount: 0, extra: {}, asNeeded: false, recipes: new Set() }));
      e.recipes.add(rn);
      if (it.qty == null) {
        e.asNeeded = true;
        continue;
      }
      const [q, u] = normQty(it.qty * factor, it.unit);
      const c = convert(q, u, ing);
      if (c == null) e.extra[u] = (e.extra[u] || 0) + q;
      else e.amount += c;
    }
  }
  return out;
}

const packCache = new Map();
/** Cheapest-in-waste combination of package sizes covering q (ties: fewer packages). */
function bestPack(q, sizes) {
  if (q <= 1e-9) return { total: 0, packs: [] };
  if (!sizes.length) return { total: q, packs: null };
  const key = `${q.toFixed(3)}|${sizes.join(';')}`;
  if (packCache.has(key)) return packCache.get(key);
  const s = [...sizes].sort((a, b) => b - a);
  let best = null;
  const counts = new Array(s.length).fill(0);
  const rec = (i, rem, total, n) => {
    if (rem <= 1e-9) {
      if (!best || total < best.total - 1e-9 || (Math.abs(total - best.total) < 1e-9 && n < best.n)) {
        best = { total, n, counts: [...counts] };
      }
      return;
    }
    if (i === s.length) return;
    const max = Math.ceil(rem / s[i] - 1e-9);
    for (let k = i === s.length - 1 ? max : 0; k <= max; k++) {
      counts[i] = k;
      rec(i + 1, rem - k * s[i], total + k * s[i], n + k);
    }
    counts[i] = 0;
  };
  rec(0, q, 0, 0);
  const result = { total: best.total, packs: s.map((size, i) => ({ size, count: best.counts[i] })).filter((p) => p.count) };
  packCache.set(key, result);
  return result;
}

function planCost(names, ctx) {
  const need = aggregate(names, ctx.people);
  let cost = 0;
  for (const [name, e] of need) {
    if (e.ing.longLasting) continue;
    if (e.asNeeded && !e.amount) cost += W.unknownQty;
    if (!e.amount) continue;
    const have = ctx.stock.get(name) || 0;
    const ref = e.ing.sizes.length ? Math.min(...e.ing.sizes) : 0;
    const buy = Math.max(0, e.amount - have);
    if (buy > 0 && ref) cost += (bestPack(buy, e.ing.sizes).total - buy) / ref;
    if (have > 0 && have !== Infinity) cost += Math.max(0, have - e.amount) / (ref || have);
  }
  for (const [name, have] of ctx.stock) {
    if (need.has(name) && (need.get(name).amount || need.get(name).asNeeded)) continue;
    const ing = getIng(name);
    if (ing.longLasting) continue;
    const ref = ing.sizes.length ? Math.min(...ing.sizes) : have;
    cost += have === Infinity ? W.unusedFridge : have / ref;
  }
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  for (const [n, c] of counts) {
    cost += (c - 1) * W.repeatWeek + c * (ctx.history.get(n) || 0) * W.repeatPast;
  }
  return cost;
}

function fridgeStock() {
  const stock = new Map();
  for (const [name, f] of Object.entries(state.fridge)) {
    if (!f.have || getIng(name).longLasting) continue;
    const a = num(f.amount);
    stock.set(name, a != null && a > 0 ? a : Infinity);
  }
  return stock;
}

/** What is left at home after cooking this week (fridge + purchased - used). */
function nextStock(names, stock) {
  const need = aggregate(names, state.settings.people);
  const next = new Map();
  for (const [name, have] of stock) {
    const e = need.get(name);
    if (!e || (!e.amount && !e.asNeeded)) next.set(name, have);
  }
  for (const [name, e] of need) {
    if (e.ing.longLasting || !e.amount) continue;
    const have = stock.get(name) || 0;
    if (have === Infinity) continue;
    const buy = Math.max(0, e.amount - have);
    const left = have + (buy > 0 ? bestPack(buy, e.ing.sizes).total : 0) - e.amount;
    if (left > 1e-6) next.set(name, left);
  }
  return next;
}

const weekRecipes = (wk) => Object.values(wk).flat().map((s) => s.recipe).filter(Boolean);

function weekStocks() {
  const stocks = [fridgeStock()];
  state.plan.weeks.forEach((wk, w) => stocks.push(nextStock(weekRecipes(wk), stocks[w])));
  return stocks;
}

function historyExcept(weekIdx, upTo = Infinity) {
  const h = new Map();
  state.plan.weeks.forEach((wk, w) => {
    if (w === weekIdx || w >= upTo) return;
    for (const n of weekRecipes(wk)) h.set(n, (h.get(n) || 0) + 1);
  });
  return h;
}

// ---------- optimizer ----------
function optimizeWeek(wk, ctx) {
  const slots = Object.keys(wk).flatMap((m) => wk[m].map((s) => ({ m, s })));
  const fixed = slots.filter((x) => x.s.locked || x.s.fixed).map((x) => x.s.recipe).filter(Boolean);
  const free = slots.filter((x) => !x.s.locked && !x.s.fixed);
  if (!free.length) return;
  const pools = Object.fromEntries(Object.keys(wk).map((m) => [m, pool(m)]));
  const cur = free.map(() => null);
  const cost = () => planCost([...fixed, ...cur.filter(Boolean)], ctx);
  let best = null;

  for (let run = 0; run < W.restarts; run++) {
    cur.fill(null);
    for (const i of shuffle(free.map((_, i) => i))) {
      let bc = Infinity;
      let br = null;
      for (const r of pools[free[i].m]) {
        cur[i] = r;
        const c = cost() + (run ? Math.random() * W.noise : 0);
        if (c < bc) [bc, br] = [c, r];
      }
      cur[i] = br;
    }
    let curCost = cost();
    for (let pass = 0, improved = true; improved && pass < 8; pass++) {
      improved = false;
      for (let i = 0; i < free.length; i++) {
        const orig = cur[i];
        let bestR = orig;
        for (const r of pools[free[i].m]) {
          if (r === orig) continue;
          cur[i] = r;
          const c = cost();
          if (c < curCost - 1e-9) [curCost, bestR] = [c, r];
        }
        cur[i] = bestR;
        if (bestR !== orig) improved = true;
      }
    }
    if (!best || curCost < best.cost) best = { cost: curCost, picks: [...cur] };
  }
  free.forEach((x, i) => { x.s.recipe = best.picks[i]; });
}

function generatePlan() {
  const s = state.settings;
  const meals = activeMeals();
  state.notices = [];
  if (!meals.length) {
    state.notices.push('Select at least one meal (lunch or dinner).');
    renderPlan();
    return;
  }
  const old = state.plan?.weeks || [];
  const weeks = Array.from({ length: s.weeks }, (_, w) => Object.fromEntries(meals.map((m) => [m,
    Array.from({ length: s.days }, (_, i) => {
      const o = old[w]?.[m]?.[i];
      return o?.locked && state.recipes.has(o.recipe) ? { recipe: o.recipe, locked: true } : { recipe: null, locked: false };
    })])));
  state.plan = { weeks };

  for (const m of meals) if (!pool(m).length) state.notices.push(`No ${m} recipes available for ${s.season} (check season or "don't want" choices).`);

  const placed = new Set(weeks.flatMap((wk) => Object.values(wk).flat().filter((x) => x.locked).map((x) => x.recipe)));
  const pending = Object.keys(state.prefs).filter((r) => state.prefs[r] === 'want' && state.recipes.has(r) && !placed.has(r));

  let stock = fridgeStock();
  weeks.forEach((wk, w) => {
    for (const m of meals) {
      for (const slot of wk[m]) {
        if (slot.locked) continue;
        const i = pending.findIndex((r) => state.recipes.get(r).meal === m);
        if (i < 0) break;
        slot.recipe = pending.splice(i, 1)[0];
        slot.fixed = true;
      }
    }
    optimizeWeek(wk, { people: s.people, stock, history: historyExcept(w, w) });
    for (const slot of Object.values(wk).flat()) delete slot.fixed;
    stock = nextStock(weekRecipes(wk), stock);
  });
  if (pending.length) state.notices.push(`Could not fit wanted dishes: ${pending.join(', ')} (no free ${[...new Set(pending.map((r) => state.recipes.get(r).meal))].join('/')} slot).`);

  state.checked = {};
  save(LS.plan, state.plan);
  save(LS.checked, state.checked);
  renderPlan();
}

function reoptimizeSlot(w, m, d) {
  const wk = state.plan.weeks[w];
  for (const slot of Object.values(wk).flat()) slot.fixed = true;
  wk[m][d].fixed = false;
  wk[m][d].locked = false;
  optimizeWeek(wk, { people: state.settings.people, stock: weekStocks()[w], history: historyExcept(w) });
  for (const slot of Object.values(wk).flat()) delete slot.fixed;
  save(LS.plan, state.plan);
}

// ---------- rendering: plan ----------
function renderPlan() {
  const root = $('#tab-plan');
  root.replaceChildren();
  for (const n of state.notices) root.append(el('p', { class: 'notice' }, n));
  if (!state.plan) {
    root.append(el('p', { class: 'hint' }, 'Tick what you have in "My fridge", choose dishes you want / don\'t want in "Dishes", then click "Generate plan".'));
    return;
  }
  root.append(el('div', { class: 'toolbar' },
    el('span', { class: 'hint' }, 'Change a dish with the dropdown (it gets kept), "Keep" protects a dish when regenerating, "Never" bans it and picks a replacement.')));
  const stocks = weekStocks();
  state.plan.weeks.forEach((wk, w) => root.append(renderWeek(wk, w, stocks[w])));
}

function renderWeek(wk, w, stock) {
  const meals = MEALS.filter((m) => wk[m]);
  const days = wk[meals[0]]?.length || 0;
  const table = el('table', { class: 'plan' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Day'), meals.map((m) => el('th', {}, cap(m))))),
    el('tbody', {}, Array.from({ length: days }, (_, d) => el('tr', {},
      el('th', {}, `Day ${d + 1}`),
      meals.map((m) => el('td', {}, slotCell(wk, w, m, d)))))));

  const counts = new Map();
  for (const n of weekRecipes(wk)) counts.set(n, (counts.get(n) || 0) + 1);
  const details = [...counts].map(([n, c]) => recipeDetails(n, c));

  return el('section', { class: 'week card' },
    el('h2', {}, `Week ${w + 1}`),
    el('div', { class: 'columns' },
      el('div', {}, table, el('h3', {}, 'Recipes'), details),
      el('div', {}, groceryList(wk, w, stock))));
}

function slotCell(wk, w, m, d) {
  const slot = wk[m][d];
  const options = [...state.recipes.values()].filter((r) => r.meal === m && (state.prefs[r.name] !== 'no' || r.name === slot.recipe));
  const select = el('select', {
    onchange: (e) => {
      slot.recipe = e.target.value || null;
      slot.locked = true;
      persistPlan();
    },
  }, el('option', { value: '' }, '-'),
  options.map((r) => el('option', { value: r.name, selected: r.name === slot.recipe }, r.name + (inSeason(r) ? '' : ' (off-season)'))));
  return [select, el('div', { class: 'slot-actions' },
    el('button', {
      class: 'small' + (slot.locked ? ' on' : ''),
      title: 'Keep this dish when regenerating',
      onclick: () => { slot.locked = !slot.locked; persistPlan(); },
    }, slot.locked ? 'Kept' : 'Keep'),
    slot.recipe && el('button', {
      class: 'small',
      title: 'Never plan this dish (and replace it here)',
      onclick: () => {
        state.prefs[slot.recipe] = 'no';
        save(LS.prefs, state.prefs);
        reoptimizeSlot(w, m, d);
        renderPlan();
        renderDishes();
      },
    }, 'Never'))];
}

function persistPlan() {
  save(LS.plan, state.plan);
  renderPlan();
}

function recipeDetails(name, count) {
  const r = state.recipes.get(name);
  const factor = state.settings.people / (r.servings || 1);
  const steps = state.instructions.get(name) || [];
  const items = r.items.map((it) => {
    const qty = it.qty == null ? 'to taste' : fmtQty(...normQty(it.qty * factor, it.unit));
    const extra = [it.component, it.note].filter(Boolean).join(', ');
    return el('li', {}, `${it.ingredient}: ${qty}`, extra && el('span', { class: 'sub' }, extra));
  });
  return el('details', {},
    el('summary', {}, name, count > 1 ? ` (x${count})` : ''),
    el('div', { class: 'sub' }, `Per meal for ${state.settings.people} people`),
    el('ul', {}, items),
    steps.length
      ? el('ol', {}, steps.map((s) => el('li', {}, s)))
      : el('p', { class: 'hint' }, 'No instructions yet (add them to data/instructions.tsv).'));
}

// ---------- rendering: grocery list ----------
function groceryList(wk, w, stock) {
  const need = aggregate(weekRecipes(wk), state.settings.people);
  const buy = [];
  const pantry = [];
  const home = [];
  const sorted = [...need.values()].sort((a, b) => a.ing.category.localeCompare(b.ing.category) || a.ing.name.localeCompare(b.ing.name));

  for (const e of sorted) {
    const { ing } = e;
    const unit = ing.unit;
    const extras = Object.entries(e.extra).map(([u, q]) => fmtQty(q, u));
    const recipes = [...e.recipes].join(', ');
    const needTxt = [e.amount ? fmtQty(e.amount, unit) : null, ...extras, e.asNeeded ? 'some' : null].filter(Boolean).join(' + ');

    if (ing.longLasting) {
      pantry.push({ e, qty: needTxt, sub: recipes });
      continue;
    }
    const have = stock.get(ing.name) || 0;
    if (have === Infinity || (e.amount && have >= e.amount && !extras.length)) {
      home.push({ e, qty: needTxt, sub: `${have === Infinity ? 'in your fridge' : `you have ${fmtQty(have, unit)}`} - ${recipes}` });
      continue;
    }
    const toBuy = Math.max(0, e.amount - have);
    const pack = bestPack(toBuy, ing.sizes);
    let qty;
    if (pack.packs?.length) qty = pack.packs.map((p) => `${p.count} x ${fmtQty(p.size, unit)}`).join(' + ');
    else qty = [toBuy ? fmtQty(toBuy, unit) : null, ...extras, e.asNeeded ? 'some' : null].filter(Boolean).join(' + ');
    if (pack.packs?.length && extras.length) qty += ` + ${extras.join(' + ')}`;
    const info = [];
    if (e.amount) info.push(`need ${needTxt}`);
    if (have) info.push(`have ${fmtQty(have, unit)}`);
    const left = pack.total - toBuy;
    if (pack.packs?.length && left > 1e-6) info.push(`leftover ${fmtQty(left, unit)}`);
    info.push(recipes);
    buy.push({ e, qty, sub: info.join(' - ') });
  }

  const section = (title, rows, prefix, hint) => rows.length ? [
    el('h3', {}, title),
    hint && el('p', { class: 'hint' }, hint),
    checklist(rows, w, prefix),
  ] : null;
  return [
    section('Grocery list', buy, 'buy'),
    section('Use from home', home, 'home'),
    section('Pantry check (long-lasting)', pantry, 'pantry', 'Usually in stock; tick when you confirmed you have it or added it to the list.'),
  ];
}

function checklist(rows, w, prefix) {
  const ul = el('ul', { class: 'checklist' });
  let lastCat = null;
  for (const row of rows) {
    if (row.e.ing.category !== lastCat) {
      lastCat = row.e.ing.category;
      ul.append(el('li', { class: 'cat' }, lastCat));
    }
    const key = `${w}|${prefix}|${row.e.ing.name}`;
    const li = el('li', { class: state.checked[key] ? 'done' : '' });
    const cb = el('input', {
      type: 'checkbox',
      checked: !!state.checked[key],
      onchange: (ev) => {
        state.checked[key] = ev.target.checked;
        li.classList.toggle('done', ev.target.checked);
        save(LS.checked, state.checked);
      },
    });
    li.append(el('label', { class: 'inline' }, cb, el('span', {}, el('span', { class: 'name' }, row.e.ing.name), el('span', { class: 'sub' }, row.sub))),
      el('span', { class: 'qty' }, row.qty));
    ul.append(li);
  }
  return ul;
}

// ---------- rendering: fridge ----------
let fridgeFilter = '';
function renderFridge() {
  const root = $('#tab-fridge');
  const filter = el('input', { type: 'text', placeholder: 'Filter...', value: fridgeFilter, oninput: (e) => { fridgeFilter = e.target.value; draw(); } });
  const grid = el('div', { class: 'fridge-grid' });
  const used = new Set([...state.recipes.values()].flatMap((r) => r.items.map((i) => i.ingredient)));
  const items = [...new Set([...state.ingredients.keys(), ...used])]
    .map(getIng)
    .filter((i) => !i.longLasting)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  function draw() {
    const q = filter.value.trim().toLowerCase();
    const groups = new Map();
    for (const i of items) {
      if (q && !i.name.toLowerCase().includes(q)) continue;
      if (!groups.has(i.category)) groups.set(i.category, []);
      groups.get(i.category).push(i);
    }
    grid.replaceChildren(...[...groups].map(([cat, list]) => el('div', { class: 'group' },
      el('div', { class: 'cat' }, cat),
      list.map((i) => {
        const f = state.fridge[i.name] || {};
        const cb = el('input', {
          type: 'checkbox',
          checked: !!f.have,
          onchange: (e) => updateFridge(i.name, { have: e.target.checked }),
        });
        return el('div', { class: 'fridge-item' },
          el('label', { class: 'inline' }, cb, i.name),
          el('input', {
            type: 'number', min: 0, step: 'any', value: f.amount ?? '',
            placeholder: i.unit ? `${i.unit === 'unit' ? 'pcs' : i.unit} (opt.)` : 'amount',
            title: 'Optional amount. Empty = assume you have enough.',
            onchange: (e) => {
              if (e.target.value !== '') cb.checked = true;
              updateFridge(i.name, { amount: e.target.value, have: cb.checked });
            },
          }));
      }))));
  }

  root.replaceChildren(
    el('p', { class: 'hint' }, 'Tick what you already have (long-lasting items are not listed). The amount is optional; leave it empty if you don\'t know.'),
    el('div', { class: 'toolbar' }, filter,
      el('button', { onclick: () => { state.fridge = {}; save(LS.fridge, state.fridge); renderFridge(); } }, 'Clear fridge')),
    grid);
  draw();
}

function updateFridge(name, patch) {
  state.fridge[name] = { ...(state.fridge[name] || {}), ...patch };
  if (!state.fridge[name].have && !state.fridge[name].amount) delete state.fridge[name];
  save(LS.fridge, state.fridge);
}

// ---------- rendering: dishes ----------
function renderDishes() {
  const root = $('#tab-dishes');
  const rows = [...state.recipes.values()].sort((a, b) => a.meal.localeCompare(b.meal) || a.name.localeCompare(b.name));
  const prefBtn = (r, value, label) => el('button', {
    class: `small ${value}` + ((state.prefs[r.name] || 'neutral') === value ? ' on' : ''),
    onclick: () => {
      if (value === 'neutral') delete state.prefs[r.name];
      else state.prefs[r.name] = value;
      save(LS.prefs, state.prefs);
      renderDishes();
    },
  }, label);
  root.replaceChildren(
    el('p', { class: 'hint' }, '"Want" dishes are placed in the plan at least once; "Don\'t want" dishes are never planned. Regenerate the plan after changing.'),
    el('table', {},
      el('thead', {}, el('tr', {}, ['Dish', 'Meal', 'Serves', 'Season', 'Tags', 'Preference'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => el('tr', { class: inSeason(r) ? '' : 'off' },
        el('td', {}, r.name),
        el('td', {}, r.meal),
        el('td', {}, r.servings),
        el('td', {}, r.seasons.length ? r.seasons.map(cap).join(', ') : 'all'),
        el('td', {}, r.tags.map((t) => el('span', { class: 'tag' }, t))),
        el('td', {}, el('div', { class: 'pref' },
          prefBtn(r, 'want', 'Want'), prefBtn(r, 'neutral', 'Maybe'), prefBtn(r, 'no', "Don't want"))))))));
}

// ---------- rendering: supermarket table ----------
function renderMarket() {
  const root = $('#tab-market');
  const usage = new Map();
  for (const r of state.recipes.values()) for (const i of r.items) usage.set(i.ingredient, (usage.get(i.ingredient) || 0) + 1);

  const commit = () => {
    buildIngredients();
    save(LS.ingredients, state.ingredientRows);
  };
  const input = (row, key, attrs = {}) => el('input', {
    type: 'text', value: row[key] ?? '', ...attrs,
    onchange: (e) => { row[key] = e.target.value.trim(); commit(); },
  });

  const body = el('tbody', {}, state.ingredientRows.map((row, idx) => el('tr', {},
    el('td', {}, input(row, 'ingredient')),
    el('td', {}, input(row, 'category')),
    el('td', {}, el('input', {
      type: 'checkbox', checked: bool(row.long_lasting),
      onchange: (e) => { row.long_lasting = e.target.checked ? 'TRUE' : 'FALSE'; commit(); },
    })),
    el('td', {}, el('select', { onchange: (e) => { row.package_unit = e.target.value; commit(); } },
      ['g', 'ml', 'unit'].map((u) => el('option', { value: u, selected: (row.package_unit || 'g') === u }, u)))),
    el('td', {}, input(row, 'package_sizes', { placeholder: 'e.g. 200;500' })),
    el('td', {}, input(row, 'unit_weight_g', { type: 'number', min: 0, step: 'any' })),
    el('td', {}, usage.get(row.ingredient) || 0),
    el('td', {}, el('button', {
      class: 'small', title: 'Delete row',
      onclick: () => { state.ingredientRows.splice(idx, 1); commit(); renderMarket(); },
    }, 'x')))));

  root.replaceChildren(
    el('p', { class: 'hint' }, 'Package sizes are what the supermarket sells (separate with ";"), in the package unit. Unit weight converts pieces to grams (e.g. 1 onion = 150 g). Edits are saved in this browser; download the TSV and commit it to data/ingredients.tsv to make them permanent.'),
    el('div', { class: 'toolbar' },
      el('button', { onclick: () => { state.ingredientRows.unshift(Object.fromEntries(ING_COLUMNS.map((c) => [c, c === 'long_lasting' ? 'FALSE' : '']))); commit(); renderMarket(); } }, 'Add row'),
      el('button', { onclick: downloadIngredients }, 'Download ingredients.tsv'),
      el('button', {
        onclick: () => {
          if (!confirm('Discard your edits and reload data/ingredients.tsv?')) return;
          localStorage.removeItem(LS.ingredients);
          state.ingredientRows = structuredClone(state.fileIngredientRows);
          buildIngredients();
          renderMarket();
        },
      }, 'Reset to file')),
    el('table', {},
      el('thead', {}, el('tr', {}, ['Ingredient', 'Category', 'Long lasting', 'Package unit', 'Package sizes', 'Unit weight (g)', 'Used in', ''].map((h) => el('th', {}, h)))),
      body));
}

function downloadIngredients() {
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]/g, ' ');
  const text = [ING_COLUMNS.join('\t'), ...state.ingredientRows.map((r) => ING_COLUMNS.map((c) => clean(r[c])).join('\t'))].join('\n') + '\n';
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/tab-separated-values' })), download: 'ingredients.tsv' });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- init ----------
function bindSettings() {
  const s = state.settings;
  const fields = { days: 'days', people: 'people', weeks: 'weeks' };
  for (const [id, key] of Object.entries(fields)) {
    const inp = $(`#${id}`);
    inp.value = s[key];
    inp.addEventListener('change', () => {
      s[key] = Math.max(1, Math.round(num(inp.value) || 1));
      inp.value = s[key];
      save(LS.settings, s);
      if (key === 'people' && state.plan) renderPlan();
    });
  }
  const season = $('#season');
  season.value = s.season;
  season.addEventListener('change', () => { s.season = season.value; save(LS.settings, s); renderDishes(); });
  for (const m of MEALS) {
    const cb = $(`#meal-${m}`);
    cb.checked = !!s[m];
    cb.addEventListener('change', () => { s[m] = cb.checked; save(LS.settings, s); });
  }
  $('#generate').addEventListener('click', () => {
    generatePlan();
    showTab('plan');
  });
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  ({ plan: renderPlan, fridge: renderFridge, dishes: renderDishes, market: renderMarket })[name]();
}

async function init() {
  const [recipeRows, itemRows, ingRows, instrRows] = await Promise.all([
    loadTsv('data/recipes.tsv'),
    loadTsv('data/recipe_ingredients.tsv'),
    loadTsv('data/ingredients.tsv'),
    loadTsv('data/instructions.tsv', true),
  ]);

  for (const r of recipeRows) {
    if (!r.recipe) continue;
    state.recipes.set(r.recipe, {
      name: r.recipe,
      meal: (r.meal || 'dinner').toLowerCase(),
      servings: num(r.servings) || 1,
      seasons: (r.seasons || '').split(/[;,]/).map((x) => x.trim().toLowerCase()).filter(Boolean),
      tags: (r.tags || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean),
      items: [],
    });
  }
  for (const r of itemRows) {
    if (!r.recipe || !r.ingredient) continue;
    if (!state.recipes.has(r.recipe)) state.recipes.set(r.recipe, { name: r.recipe, meal: 'dinner', servings: 1, seasons: [], tags: [], items: [] });
    state.recipes.get(r.recipe).items.push({ ingredient: r.ingredient, qty: num(r.quantity), unit: r.unit, component: r.component, note: r.note });
  }
  const steps = new Map();
  for (const r of instrRows) {
    if (!r.recipe || !r.instruction) continue;
    if (!steps.has(r.recipe)) steps.set(r.recipe, []);
    steps.get(r.recipe).push([num(r.step) ?? Infinity, r.instruction]);
  }
  for (const [k, list] of steps) state.instructions.set(k, list.sort((a, b) => a[0] - b[0]).map((x) => x[1]));

  state.fileIngredientRows = ingRows;
  state.ingredientRows = load(LS.ingredients, null) || structuredClone(ingRows);
  buildIngredients();

  state.settings = { ...state.settings, ...load(LS.settings, {}) };
  state.fridge = load(LS.fridge, {});
  state.prefs = load(LS.prefs, {});
  state.plan = load(LS.plan, null);
  state.checked = load(LS.checked, {});

  bindSettings();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  renderPlan();
}

init().catch((err) => {
  const box = $('#error');
  box.hidden = false;
  box.textContent = `${err.message}. If you opened index.html directly, serve the folder instead (e.g. "python -m http.server") or use GitHub Pages.`;
});
