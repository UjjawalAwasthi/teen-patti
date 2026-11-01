// Teen Patti hand evaluation
// Ranking (high to low): Trail > Pure Sequence > Sequence > Colour > Pair > High Card
// Sequences: A-K-Q is the highest, A-2-3 is the lowest (Ace plays high or low). K-A-2 is not valid.
// Ties: compare card values from highest down; if still equal, compare suits
// card by card (Spades > Hearts > Diamonds > Clubs).

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_VALUE = { S: 4, H: 3, D: 2, C: 1 };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CATEGORY = { 6: 'Trail', 5: 'Pure Sequence', 4: 'Sequence', 3: 'Colour', 2: 'Pair', 1: 'High Card' };

function rankLabel(r) { return RANK_LABEL[r] || String(r); }

function buildShoe(decks) {
  const shoe = [];
  let id = 0;
  for (let d = 0; d < decks; d++)
    for (const s of SUITS)
      for (let r = 2; r <= 14; r++) shoe.push({ id: id++, r, s });
  return shuffle(shoe);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Returns { cat, name, ranks:[...], suits:[...] } where ranks/suits are in comparison order
function evaluate(cards) {
  const c = [...cards].sort((a, b) => b.r - a.r || SUIT_VALUE[b.s] - SUIT_VALUE[a.s]);
  const [a, b, d] = c.map(x => x.r);
  const flush = c[0].s === c[1].s && c[1].s === c[2].s;
  let seq = false, seqOrder = c;
  if (a - b === 1 && b - d === 1) seq = true;
  else if (a === 14 && b === 3 && d === 2) { // A-2-3, lowest sequence
    seq = true;
    seqOrder = [c[1], c[2], { ...c[0], r: 1 }];
  }
  let cat, ordered;
  if (a === b && b === d) { cat = 6; ordered = c; }
  else if (seq && flush) { cat = 5; ordered = seqOrder; }
  else if (seq) { cat = 4; ordered = seqOrder; }
  else if (flush) { cat = 3; ordered = c; }
  else if (a === b || b === d) {
    cat = 2;
    const pairRank = b; // middle card is always part of the pair when sorted
    const pair = c.filter(x => x.r === pairRank);
    const kicker = c.filter(x => x.r !== pairRank);
    ordered = [...pair, ...kicker];
  } else { cat = 1; ordered = c; }
  return {
    cat,
    name: CATEGORY[cat],
    ranks: ordered.map(x => x.r),
    suits: ordered.map(x => SUIT_VALUE[x.s]),
  };
}

// > 0 if hand A beats hand B, < 0 if B beats A, 0 if completely identical
function compare(handA, handB) {
  const x = evaluate(handA), y = evaluate(handB);
  if (x.cat !== y.cat) return x.cat - y.cat;
  for (let i = 0; i < 3; i++) if (x.ranks[i] !== y.ranks[i]) return x.ranks[i] - y.ranks[i];
  for (let i = 0; i < 3; i++) if (x.suits[i] !== y.suits[i]) return x.suits[i] - y.suits[i];
  return 0;
}

function describe(cards) {
  const e = evaluate(cards);
  return e.name;
}

module.exports = { buildShoe, shuffle, evaluate, compare, describe, rankLabel };
