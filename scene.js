// 情景：投げたときの時間帯・天気・場所の雰囲気。座標そのものは保存せず、ことばだけ残す
// 天気は Open-Meteo（無料・鍵なし）。位置は端末の許可があるときだけ

const timeOfDay = (d = new Date()) => {
  const h = d.getHours();
  return h < 4 ? '深夜' : h < 10 ? '朝' : h < 15 ? '昼' : h < 18 ? '夕方' : h < 23 ? '夜' : '深夜';
};

// WMO の天気コード → ことば
const weatherWord = (c) => (c == null ? '' : c === 0 || c === 1 ? '晴れ' : c <= 3 ? 'くもり' : c <= 48 ? '霧'
  : c <= 67 || (c >= 80 && c <= 82) ? '雨' : c <= 77 || c === 85 || c === 86 ? '雪' : '雷');

let posCache = null, posAt = 0, wxCache = null, wxAt = 0;

function position() {
  if (posCache && Date.now() - posAt < 10 * 60e3) return Promise.resolve(posCache);
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { posCache = { lat: p.coords.latitude, lon: p.coords.longitude }; posAt = Date.now(); resolve(posCache); },
      () => resolve(null), { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60e3 });
  });
}

async function weather(pos) {
  if (!pos) return '';
  if (wxCache && Date.now() - wxAt < 30 * 60e3) return wxCache;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${pos.lat.toFixed(2)}&longitude=${pos.lon.toFixed(2)}&current=weather_code`;
    const j = await (await fetch(u)).json();
    wxCache = weatherWord(j.current && j.current.weather_code); wxAt = Date.now();
    return wxCache;
  } catch { return ''; }
}

const dist = (a, b) => {
  const R = 6371e3, r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * R;
};

// places: { 家: {lat, lon}, 職場: {lat, lon} }（設定にあれば）
export async function currentScene(places) {
  const pos = await position();
  const parts = [];
  const wx = await weather(pos);
  if (wx) parts.push(wx);
  parts.push(timeOfDay());
  if (pos) {
    let label = '外';
    for (const [name, p] of Object.entries(places || {})) if (p && dist(pos, p) < 350) label = name;
    parts.push(label);
  }
  return parts.join(' ');
}

export async function hereRounded() {
  const p = await position();
  return p ? { lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3) } : null;
}

export const sceneLabel = (s) => {
  if (!s) return '';
  const icon = /雨/.test(s) ? '☔' : /雪/.test(s) ? '❄' : /晴れ/.test(s) ? '☀' : /くもり|霧/.test(s) ? '☁' : /雷/.test(s) ? '⚡' : '🕰';
  const [a, b, c] = s.split(' ');
  return `${icon} ` + (s.split(' ').length === 3 ? `${a}の${b}・${c}` : s.replace(/ /g, '・'));
};

// 「雨の朝」「夜 家」などから情景のことばを取り出す。残りは意味で探す
const SCENE = [
  [/雨/, '雨'], [/晴/, '晴れ'], [/曇|くもり/, 'くもり'], [/雪/, '雪'], [/霧/, '霧'], [/雷/, '雷'],
  [/深夜|夜中/, '深夜'], [/朝/, '朝'], [/昼/, '昼'], [/夕方|夕暮れ|夕/, '夕方'], [/夜/, '夜'],
  [/自宅|家で|おうち|(^|[\sの])家(?=$|[\sのでに])/, '家'], [/職場|会社で|オフィス/, '職場'], [/出先|外出|外で/, '外'],
];
export function parseSceneQuery(q) {
  let rest = q;
  const words = [];
  for (const [re, w] of SCENE) {
    if (re.test(rest) && !words.includes(w)) { words.push(w); rest = rest.replace(re, ' '); }
  }
  rest = rest.replace(/[のにでとやへ・、\s]+/g, ' ').trim();
  return { words, rest };
}
