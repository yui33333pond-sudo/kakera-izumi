// お試しモード（?demo）の中身。本物の原文ではなく、形を見るための見本
export async function seedDemo(store, byKey) {
  const box = (key) => byKey.get(key);
  const b240 = box('kanki/200番台 総括/240'), cash = box('kamoku/貸借対照表/資産/流動資産/現金預金'), tana = box('genba/棚卸立会');
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();

  // 240：節（地図のマス）・原文の段落・私語訳・図
  const secs = store.put('sections', [
    { box_id: b240.id, seq: 1, title: '不正と誤謬', phase: 'kamae', want: false, ok_at: ago(3), diagram: { type: 'contrast', left: { title: '不正', items: [{ t: '意図がある', tone: 'in' }] }, right: { title: '誤謬', items: [{ t: '意図がない', tone: 'out' }] } } },
    { box_id: b240.id, seq: 2, title: '職業的懐疑心', phase: 'kamae', want: false, ok_at: null, diagram: { type: 'hub', center: '職業的懐疑心', around: ['鵜呑みにしない', '前年と同じと思わない', { t: '記録を確かめる', tone: 'in' }] } },
    { box_id: b240.id, seq: 3, title: 'リスクの識別', phase: 'mitsukeru', want: true, ok_at: null, diagram: null },
    { box_id: b240.id, seq: 4, title: '収益認識の推定', phase: 'mitsukeru', want: false, ok_at: null, diagram: { type: 'inout', label: '不正リスクがあると推定するもの', inside: ['収益認識'], outside: [{ t: '推定しないなら理由を残す', tone: 'note' }] } },
    { box_id: b240.id, seq: 5, title: '経営者による内部統制の無効化', phase: 'taio', want: false, ok_at: null, diagram: { type: 'flow', steps: ['仕訳を確かめる', '見積りの偏りを見る', { t: '異常な取引の理由を聞く', tone: 'in' }] } },
    { box_id: b240.id, seq: 6, title: '経営者確認書と伝達', phase: 'shimeru', want: false, ok_at: null, diagram: null },
  ]);
  const P = [
    [0, '1', '（見本）この基準は、財務諸表監査で不正をどう扱うかを定めている。'],
    [0, '2', '（見本）虚偽表示は、不正か誤謬かで分かれる。分かれ目は、意図があったかどうか。'],
    [1, '12', '（見本）監査人は、経営者が正直だと思っていても、不正が起きうると考えて監査を進める。'],
    [2, '16', '（見本）チームで話し合い、どこに不正が入り込みやすいかを考える。'],
    [3, '26', '（見本）収益認識には不正リスクがあると推定する。推定しないときは、その理由を調書に残す。'],
    [4, '31', '（見本）経営者は内部統制を無視できる立場にあるので、そのリスクには毎回対応する。'],
    [5, '39', '（見本）不正を見つけたら、適切な階層の経営者に速やかに伝える。'],
  ];
  const paras = store.put('paras', P.map(([si, label, body], i) => ({ box_id: b240.id, section_id: secs[si].id, seq: i + 1, label, body })));
  const tr = [
    [0, 'わざと → 不正。うっかり → 誤謬。', [1]],
    [0, 'この基準が見るのは「わざと」のほう。', [0]],
    [1, '「いい人そう」は、不正がない理由にならない。', [2]],
    [3, '売上は最初から「あやしい」前提で見る。', [4]],
    [3, '「あやしくない」と言うなら、理由を書き残す。', [4]],
    [4, '経営者は統制をすり抜けられる。だから毎回見る。', [5]],
  ];
  tr.forEach(([si, body, ps], i) => store.addCard({ box_id: b240.id, kind: 'trans', section_id: secs[si].id, seq: i, body, para_ids: ps.map((x) => paras[x].id) }));

  // 現金預金：アサーション軸 × ラベル
  const R = [
    ['jitsuzai', ['abunai'], '架空の預金、残高証明と帳簿のずれ', ago(10)],
    ['jitsuzai', ['tashikameru', 'genba'], '期末日に現金を実査し、手許有高と帳簿を合わせる', ago(10)],
    ['moura', ['tashikameru'], '銀行確認状を全口座に出す（残高ゼロの口座も）', null],
    ['kikan', ['abunai', 'hani'], '期末日前後の入出金、未達取引', null],
    ['hyoka', ['tashikameru'], '外貨預金の換算レート', null],
    ['hyoji', ['hani'], '担保に入っている預金の注記', null],
    ['tosei', ['tashikameru'], '小口現金の管理者と記帳者が分かれているか', null],
  ];
  R.forEach(([axis, labels, body, ok], i) => store.addCard({ box_id: cash.id, kind: 'row', axis, labels, body, seq: i, ok_at: ok }));
  store.addCard({ box_id: cash.id, kind: 'note', body: '実査のとき、金庫の中の小切手と収入印紙も数えるか迷った', tags: [tana.id], created_at: ago(2) });
  store.addCard({ box_id: b240.id, kind: 'note', body: '収益認識の「推定しない理由」って、実際どんなときに書く？', created_at: ago(5) });

  // 付箋・つながり・前の泉
  store.put('stickies', [{ body: '預金の残高確認、届かない銀行はどうする？', hint_box: cash.id, created_at: ago(0.2) }, { body: '不正の三角形ってどこに書いてあった？', hint_box: null, created_at: ago(1) }]);
  await store.addLink(b240.id, box('kanki/500番台 監査証拠/505').id);
  store.put('kakera', [
    { body: '棚卸立会：次は保管場所の一覧を先にもらっておく', created_at: ago(30), seq: 0, group_id: null, source: 'hand' },
    { body: 'accrual って発生主義のことか。メルマガで出てきた', created_at: ago(40), seq: 0, group_id: null, source: 'hand' },
  ]);
  const g = 'demo-letter-1';
  store.put('kakera', [
    { body: '【Morning Brief】Auditors face new rules on climate disclosures\n\nRegulators announced on Monday that auditors will be required to provide assurance over companies’ climate-related disclosures.', created_at: ago(1), seq: 0, group_id: g, source: 'gmail' },
    { body: 'The new standard takes effect for fiscal years beginning after January 2027. Critics argue that the timeline is too aggressive, while investors have welcomed the move.', created_at: ago(1), seq: 1, group_id: g, source: 'gmail' },
    { body: '【週刊ニュース】今週のまとめ\n\n日本語のメルマガはこれまでどおり前の泉に残る。', created_at: ago(3), seq: 0, group_id: 'demo-letter-2', source: 'gmail' },
  ]);
  // 育ち：前の月にも納得を少し・1年前のかけら
  for (const [i, r] of store.T.cards.filter((c) => c.kind === 'row' && !c.ok_at).slice(0, 2).entries()) r.ok_at = ago(40 + i * 35);
  store.put('kakera', [{ body: '一年前：初めての棚卸立会。寒かった', created_at: ago(364), seq: 0, group_id: null, source: 'hand' }]);
  for (const k of ['kanki/200番台 総括/240', 'kamoku/貸借対照表/資産/流動資産/現金預金']) await store.touchNode(box(k).id);
}
