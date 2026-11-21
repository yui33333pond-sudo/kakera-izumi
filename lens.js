// レンズの見分けと、英単語の拾い出し（すべて端末の中で）

export const LENSES = [
  { id: 'word', label: '英単語' },
  { id: 'article', label: '英語の記事' },
  { id: 'accounting', label: '会計' },
  { id: 'daily', label: '日々' },
];
export const lensLabel = (id) => (LENSES.find((l) => l.id === id) || {}).label || '';

// 会計 / 日々 を見分けるための「お手本の文」
const PROTOS = {
  accounting: [
    '仕訳と勘定科目の処理', '監査手続とリスク評価', '収益認識やリースの会計基準', '財務諸表と決算の論点',
    '内部統制と不正リスク', '税務と連結決算', 'Audit procedures and financial reporting standards',
    'journal entries, accruals and revenue recognition',
  ],
  daily: [
    '今日の出来事と気分', '疲れた、眠い、散歩した', '週末の予定や食べたもの', '家族や友だちとの会話',
    '天気と体調のこと', '買い物と家のこと', 'I felt tired today and went for a walk', 'what I ate and how I slept',
  ],
};
let protoVecs = null;
export async function loadProtos(embed) {
  if (!protoVecs) {
    protoVecs = (async () => {
      const out = {};
      for (const [k, list] of Object.entries(PROTOS)) out[k] = await embed(list);
      return out;
    })();
  }
  return protoVecs;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const top2 = (vec, list) => { const s = list.map((v) => dot(vec, v)).sort((a, b) => b - a); return (s[0] + s[1]) / 2; };

// メルマガの頭に付けた「【差出人】件名」は見分けに使わない
const stripHeader = (body) => body.replace(/^【[^】]*】[^\n]*\n*/, '');

function stats(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(/[぀-ヿ㐀-鿿]/g) || []).length;
  const words = text.match(/[A-Za-z][A-Za-z'-]+/g) || [];
  return { ratio: latin / Math.max(1, latin + cjk * 2), words: words.length, len: text.length };
}

// row: { body, source }, vec: その本文の埋め込み
export function classify(row, vec, protos) {
  const text = stripHeader(row.body).trim();
  const s = stats(text);
  const fromMail = row.source === 'gmail' || row.source === 'yahoo';
  if (!fromMail && s.len <= 80 && s.words >= 1 && s.words <= 4) return 'word';
  if (s.ratio >= 0.5 && s.words >= 8 && (fromMail || s.len >= 200)) return 'article';
  if (!protos) return null;
  return top2(vec, protos.accounting) >= top2(vec, protos.daily) ? 'accounting' : 'daily';
}

// ---- 英単語を拾う ----
const norm = (w) => {
  w = w.toLowerCase().replace(/[’']s$/, '').replace(/^[-']+|[-']+$/g, '');
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return w;
};

// 自分で投げた英単語レンズのかけらから：ほぼ全部（ごく短い機能語だけ除く）
export function wordsFromMine(body) {
  const out = new Set();
  for (const m of body.matchAll(/[A-Za-z][A-Za-z'’-]*[A-Za-z]/g)) {
    const w = norm(m[0]);
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return [...out];
}

// メルマガから：よく使う単語・固有名詞っぽいもの・略語は除く
export function wordsFromMail(body) {
  const text = stripHeader(body);
  const out = new Set();
  for (const m of text.matchAll(/[A-Za-z][A-Za-z'’-]*[A-Za-z]/g)) {
    const raw = m[0];
    if (raw.length < 4 || raw === raw.toUpperCase()) continue;          // 略語（PCAOB など）
    if (/[A-Z]/.test(raw[0])) {                                          // 文の頭以外の大文字始まりは固有名詞とみなす
      const before = text.slice(0, m.index).trimEnd();
      if (before && !/[.!?。！？:\n"“]$/.test(before)) continue;
    }
    const w = norm(raw);
    if (w.length >= 4 && !COMMON.has(w) && !COMMON.has(raw.toLowerCase()) && !STOP.has(w)) out.add(w);
  }
  return [...out];
}

const STOP = new Set('the a an and or but of to in on at by for with from as is are was were be been being it its this that these those there their they them he she his her you your we our us i me my not no so do does did done have has had can could will would shall should may might must also than then into onto over under about after before such per via etc'.split(' '));

// よく使う英単語（これらはメルマガから拾わない）
const COMMON = new Set(`
about above across action activity actually add added addition address after again against age ago agree ahead allow almost alone along already although always among amount analysis another answer anyone anything appear apply approach area around arrive article ask available average away back based basic basis because become before begin behind believe below best better between beyond big bill billion black blue board body book both box break bring brother build building business busy call came campaign capital car care career carry case cause center central certain chair challenge chance change character charge check child children choice choose city class clear close club cold college come coming common community company compare complete concern condition conference consider continue control cost could country couple course court cover create crisis current customer cut daily data date daughter day deal death decade decide decision deep degree department describe design detail develop development difference different difficult digital direct director discuss discussion doctor does dollar door down draw dream drive during each early easy economic economy edge education effect effort either election else email employee end energy enjoy enough enter entire environment equal especially even evening event ever every everyone everything evidence exactly example expect experience expert explain eye face fact fail fall family far fast father fear feature feel feeling few field fight figure fill film final finally find fine finish fire firm first fit five floor focus follow food foot force foreign forget form former forward four free friend front full fund future game garden general generation get girl give given glass global goal going good government great green ground group grow growth guess guide half hand happen happy hard head health hear heart heavy help here high himself history hold home hope hospital hot hotel hour house however huge human hundred idea identify image imagine impact important improve include including increase indeed industry information inside instead interest interesting international interview investment involve issue item itself job join just keep key kid kind kitchen know knowledge land language large last late later laugh launch law lead leader learn least leave left legal less let letter level life light like likely line list listen little live local long look lose loss lot love low machine made main maintain major make man manage management manager many market marketing matter maybe mean measure media meet meeting member memory mention message method middle might million mind minute miss model modern moment money month more morning most mother move movie much music myself name nation national natural nature near nearly necessary need network never new news next nice night none nor north note nothing notice now number offer office officer official often okay old once one online only open operation opportunity option order other others out outside own owner page pain paper parent part particular partner party pass past patient pay people percent perfect perform performance perhaps period person personal phone pick picture piece place plan plant play player please point police policy political poor popular population position positive possible post power practice prepare present president pressure pretty prevent price private probably problem process produce product production professional program project property protect prove provide public pull purpose push put quality question quickly quite race raise range rate rather reach read ready real reality realize really reason receive recent recently recognize record red reduce reflect region relate relationship remain remember remove report represent require research resource respond response rest result return reveal rich right rise risk road rock role room rule run safe said sale same save say scene school science screen sea season seat second section security see seek seem sell send senior sense series serious serve service set seven several shake share short shot show side sign significant similar simple simply since sing single sister site situation six size skill small social society soldier some someone something sometimes son song soon sort sound source south space speak special specific speech spend sport spring staff stage stand standard star start state statement station stay step still stock stop store story strategy street strong structure student study stuff style subject success successful suddenly suffer suggest summer support sure surface system table take talk task team technology television tell ten tend term test than thank that themselves theory thing think third though thought thousand threat three through throughout throw thus time today together tonight too top total toward town trade traditional training travel treat treatment tree trial trip trouble true truth try turn type under understand unit until upon usually value various very victim view visit voice vote wait walk wall want watch water way weapon wear week weight well west western what whatever when where whether which while white whole whom whose why wide wife will win window wish within without woman wonder word work worker world worry write writer wrong yard yeah year yes yet young yourself
week weekly month monthly today tomorrow yesterday click link here subscribe newsletter email read more view online browser privacy unsubscribe copyright rights reserved update updates new latest issue team welcome thanks thank regards dear hello
also able across added adding allows almost along already announce announced annual applied asked based began being called came cannot comes coming companies company's considered continued could created days didn't doesn't don't during early either else ended even every expected feel felt find first five found four gave gets getting goes going gone got great half having held help helps however i'm including into it's just keep kept known large last least less let's likely little long looking looks made make makes making many means might million more most much need needs next often once only other others ours part past people place plans put rather really right said saying says second seen sent shows since six small some still such sure take taken takes taking tell tells than that's them then there's things think third those though three through told took toward under until upon used uses using very want wants ways well went were what's where which while who's whole will with within won't work works worked would year years you're
`.trim().split(/\s+/));
