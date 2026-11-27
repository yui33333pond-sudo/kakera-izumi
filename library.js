// 書庫の形：棚（6つ）＞決まった順番の階層＞箱。
// ここに書いた場所は、ログインしたときに足りない分だけデータベースに足す（消したり並べ替えたりはしない）。
// 書き方：[名前, [子…]] は階層、'名前' だけなら箱。監基報は '番号 短い名前'。

export const SHELVES = [
  { id: 'kanki', name: '監基報', color: '#3b4fd8', shape: 'square' },
  { id: 'kamoku', name: '勘定科目', color: '#0f7a8a', shape: 'stack' },
  { id: 'eigo', name: '英語', color: '#7a3fc4', shape: 'circle' },
  { id: 'hon', name: '本', color: '#9a5b1e', shape: 'book' },
  { id: 'genba', name: '現場', color: '#c43a5b', shape: 'triangle' },
  { id: 'nichijo', name: '日常', color: '#55606a', shape: 'leaf' },
];
export const shelfOf = (id) => SHELVES.find((s) => s.id === id);

const TREE = {
  kanki: [
    ['200番台 総括', ['200 総括的な目的', '210 契約条件の合意', '220 品質管理', '230 監査調書', '240 不正', '250 法令', '260 監査役等とのコミュニケーション', '265 内部統制の不備の報告']],
    ['300・400番台 リスクの評価と対応', ['300 監査計画', '315 リスクの識別と評価', '320 重要性', '330 リスク対応手続', '402 委託業務', '450 虚偽表示の評価']],
    ['500番台 監査証拠', ['500 監査証拠', '501 特定項目の監査証拠', '505 確認', '510 期首残高', '520 分析的手続', '530 監査サンプリング', '540 会計上の見積り', '550 関連当事者', '560 後発事象', '570 継続企業', '580 経営者確認書']],
    ['600番台 ほかの人の作業の利用', ['600 グループ監査', '610 内部監査の利用', '620 専門家の業務の利用']],
    ['700番台 意見と報告', ['700 意見の形成と監査報告', '701 監査上の主要な検討事項', '705 除外事項付意見', '706 強調事項とその他の事項', '710 比較情報', '720 その他の記載内容']],
    ['800番台 特別な目的', ['800 特別目的の財務諸表', '805 個別の財務表', '810 要約財務諸表']],
    ['900番台', ['900 監査人の交代', '910 中間監査']],
  ],
  kamoku: [
    ['貸借対照表', [
      ['資産', [
        ['流動資産', ['現金預金', '受取手形・売掛金', '有価証券', '棚卸資産', '前払費用', 'その他の流動資産', '貸倒引当金']],
        ['固定資産', ['有形固定資産', '無形固定資産', '投資有価証券', '関係会社株式', '繰延税金資産']],
      ]],
      ['負債', [
        ['流動負債', ['支払手形・買掛金', '短期借入金', '未払金・未払費用', '未払法人税等', '賞与引当金']],
        ['固定負債', ['長期借入金', '社債', '退職給付に係る負債', '資産除去債務', 'リース債務']],
      ]],
      ['純資産', ['資本金・資本剰余金', '利益剰余金', '自己株式', 'その他の包括利益累計額']],
    ]],
    ['損益計算書', ['売上高', '売上原価', '販売費及び一般管理費', '営業外損益', '特別損益', '法人税等']],
  ],
  eigo: ['英字新聞', '単語帳'],
  hon: [],
  genba: ['棚卸立会', '現金実査'],
  nichijo: [],
};

const pad = (n) => String(n).padStart(3, '0');
// 場所の一覧（親から順に）。key は場所の名前（監基報は番号）。途中に足しても、前からある場所はずれない
const keyOf = (title) => (title.match(/^(\d{3})\s/) || [null, title])[1];
export function libraryRows() {
  const rows = [];
  const walk = (shelf, list, parentKey, sortBase) => {
    list.forEach((item, i) => {
      const sort = `${sortBase}.${pad(i)}`;
      const key = `${parentKey}/${keyOf(Array.isArray(item) ? item[0] : item)}`;
      if (Array.isArray(item)) {
        rows.push({ shelf, key, parent_key: parentKey, title: item[0], sort, is_box: false });
        walk(shelf, item[1], key, sort);
      } else rows.push({ shelf, key, parent_key: parentKey, title: item, sort, is_box: true });
    });
  };
  SHELVES.forEach((s, i) => walk(s.id, TREE[s.id], s.id, pad(i)));
  return rows;
}

// 勘定科目の箱：アサーション軸とラベル
export const AXES = [
  ['jitsuzai', '実在性'], ['moura', '網羅性'], ['kikan', '期間帰属'], ['hyoka', '評価'], ['hyoji', '表示'], ['tosei', '統制'],
];
export const LABELS = { abunai: ['危ない', '#c8321e'], tashikameru: ['確かめる', '#2a59c9'], hani: ['範囲', '#7a3fc4'], genba: ['現場', '#9a5b1e'] };
// 監基報の地図
export const PHASES = [['kamae', '構え'], ['mitsukeru', '見つける'], ['taio', '対応'], ['shimeru', '締める']];
