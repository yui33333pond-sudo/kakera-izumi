#!/usr/bin/env python3
"""
かけらの泉：Yahoo メールの「泉行き」フォルダを一括で取り込む（Mac のターミナルで動かす）

    python3 tools/yahoo_import.py          # 何が沈むかを見るだけ（送らない）
    python3 tools/yahoo_import.py --send   # 本当に沈める

- Yahoo のパスワードと取り込み専用の鍵は、実行中に聞かれる（画面に出ない・どこにも保存しない）
- Supabase の URL と公開用の鍵は config.js から読む
- 同じメールは二度入らないので、何度実行しても大丈夫
- Python の標準機能だけで動く（追加のインストールなし）
"""
import argparse
import email
import email.header
import email.utils
import getpass
import html
import imaplib
import json
import re
import ssl
import sys
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX = 260  # 1段落のめやす（アプリと同じ）


# ---------- 設定 ----------
def read_config():
    js = (ROOT / 'config.js').read_text(encoding='utf-8')
    url = re.search(r"supabaseUrl:\s*'([^']+)'", js)
    key = re.search(r"supabaseKey:\s*'([^']+)'", js)
    if not url or not key:
        sys.exit('config.js に supabaseUrl と supabaseKey が入っていない')
    return url.group(1).rstrip('/'), key.group(1)


def imap_host(address):
    domain = address.split('@')[-1].lower()
    if domain.endswith('yahoo.co.jp') or domain.endswith('ymail.ne.jp'):
        return 'imap.mail.yahoo.co.jp'
    return 'imap.mail.yahoo.com'


# ---------- IMAP のフォルダ名（日本語は modified UTF-7 にする） ----------
def imap_utf7(s):
    out, buf = [], []

    def flush():
        if buf:
            b = ''.join(buf).encode('utf-16-be')
            import base64
            out.append('&' + base64.b64encode(b).decode().rstrip('=').replace('/', ',') + '-')
            buf.clear()

    for ch in s:
        if 0x20 <= ord(ch) <= 0x7e:
            flush()
            out.append('&-' if ch == '&' else ch)
        else:
            buf.append(ch)
    flush()
    return ''.join(out)


# ---------- メール → 文字 ----------
def decode_header(v):
    if not v:
        return ''
    parts = []
    for text, enc in email.header.decode_header(v):
        if isinstance(text, bytes):
            try:
                text = text.decode(enc or 'utf-8', errors='replace')
            except LookupError:
                text = text.decode('utf-8', errors='replace')
        parts.append(text)
    return ''.join(parts).strip()


def html_to_text(h):
    h = re.sub(r'(?is)<(script|style|head)[^>]*>.*?</\1>', '', h)
    h = re.sub(r'(?i)<br\s*/?>', '\n', h)
    h = re.sub(r'(?i)</(p|div|tr|h[1-6]|li|table|blockquote)>', '\n\n', h)
    h = re.sub(r'(?s)<[^>]+>', '', h)
    h = html.unescape(h)
    return re.sub(r'\n[ \t]+', '\n', h)


def body_text(msg):
    plain, rich = None, None
    for part in msg.walk():
        if part.get_content_maintype() == 'multipart' or part.get_filename():
            continue
        ctype = part.get_content_type()
        if ctype not in ('text/plain', 'text/html'):
            continue
        raw = part.get_payload(decode=True) or b''
        cs = part.get_content_charset() or 'utf-8'
        try:
            text = raw.decode(cs, errors='replace')
        except LookupError:
            text = raw.decode('utf-8', errors='replace')
        if ctype == 'text/plain' and plain is None:
            plain = text
        elif ctype == 'text/html' and rich is None:
            rich = text
    if plain and plain.strip():
        return plain
    return html_to_text(rich or '')


# ---------- 整える・分ける（Gmail の見張り番と同じ考え方） ----------
FOOT = re.compile(r'(配信停止|配信解除|購読解除|登録解除|メール配信の停止|unsubscribe|manage (your )?(preferences|subscription)|このメールは.{0,30}(送信|配信)専用)', re.I)
DECO = re.compile(r'^[-=_*#~─━＝＊・◆◇■□●○★☆…\s]{4,}$')


def clean(text):
    t = text.replace('\r\n', '\n').replace('\r', '\n').replace(' ', ' ')
    t = re.sub(r'https?://\S{50,}', '', t)
    lines = [l for l in t.split('\n')
             if not re.fullmatch(r'https?://\S+', l.strip()) and not DECO.fullmatch(l.strip())]
    for i in range(int(len(lines) * 0.6), len(lines)):
        if FOOT.search(lines[i]):
            j = i
            while j > 0 and lines[j - 1].strip():
                j -= 1
            lines = lines[:j]
            break
    t = '\n'.join(lines)
    t = re.sub(r'[ \t]+\n', '\n', t)
    return re.sub(r'\n{3,}', '\n\n', t).strip()


def split_paras(text):
    t = text.strip()
    if not t:
        return []
    if len(t) <= MAX:
        return [t]
    out = []
    for block in re.split(r'\n\s*\n', t):
        b = block.strip()
        if not b:
            continue
        if len(b) <= MAX * 1.6:
            out.append(b)
            continue
        cur = ''
        for s in re.split(r'(?<=[。．！？!?\n])|(?<=\.\s)', b):
            if cur and len(cur + s) > MAX:
                out.append(cur.strip())
                cur = ''
            cur += s
        if cur.strip():
            out.append(cur.strip())
    merged = []
    for p in out:
        if merged and (len(p) < 40 or len(merged[-1]) < 40):
            merged[-1] += '\n\n' + p
        else:
            merged.append(p)
    return merged


def to_kakera(msg, fallback_ref):
    name, addr = email.utils.parseaddr(decode_header(msg.get('From')))
    sender = name or addr or '差出人不明'
    subject = decode_header(msg.get('Subject'))
    paras = split_paras(clean(body_text(msg)))
    if not paras:
        return []
    paras[0] = f'【{sender}】{subject}\n\n{paras[0]}'
    try:
        when = email.utils.parsedate_to_datetime(msg.get('Date')).astimezone(timezone.utc)
    except Exception:
        when = datetime.now(timezone.utc)
    ref = (msg.get('Message-ID') or fallback_ref).strip().strip('<>')
    group = str(uuid.uuid4())
    return [{
        'body': p, 'seq': i, 'group_id': group, 'created_at': when.isoformat(),
        'source': 'yahoo', 'source_ref': f'{ref}:{i}',
    } for i, p in enumerate(paras)]


# ---------- 送る ----------
def send(url, key, token, items):
    req = urllib.request.Request(
        f'{url}/rest/v1/rpc/ingest_kakera',
        data=json.dumps({'token': token, 'items': items}).encode(),
        headers={'apikey': key, 'Content-Type': 'application/json'},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return int(r.read().decode() or 0)
    except urllib.error.HTTPError as e:
        sys.exit(f'泉に届かなかった {e.code}: {e.read().decode()[:300]}')


# ---------- 本体 ----------
def main():
    ap = argparse.ArgumentParser(description='Yahoo メールのフォルダを泉に取り込む')
    ap.add_argument('--send', action='store_true', help='本当に沈める（付けないと見るだけ）')
    ap.add_argument('--folder', default='泉行き', help='取り込むフォルダ名（初期値：泉行き）')
    args = ap.parse_args()

    url, key = read_config()
    address = input('Yahoo メールのアドレス: ').strip()
    password = getpass.getpass('Yahoo のパスワード（画面には出ない）: ')
    token = getpass.getpass('取り込み専用の鍵（画面には出ない）: ').strip() if args.send else None

    host = imap_host(address)
    print(f'{host} につないでいる…')
    try:
        imap = imaplib.IMAP4_SSL(host, 993, ssl_context=ssl.create_default_context())
        imap.login(address, password)
    except imaplib.IMAP4.error as e:
        sys.exit(f'Yahoo に入れなかった：{e}\n'
                 '→ Yahoo メールの設定で「IMAP/POP/SMTPアクセス」を有効にしているか確かめてね（README 参照）')
    finally:
        password = None

    status, _ = imap.select('"' + imap_utf7(args.folder) + '"', readonly=True)
    if status != 'OK':
        print(f'フォルダ「{args.folder}」が見つからない。あるフォルダ：')
        for line in imap.list()[1]:
            print('  ', line.decode(errors='replace'))
        sys.exit(1)

    _, data = imap.uid('search', None, 'ALL')
    uids = data[0].split()
    print(f'「{args.folder}」に {len(uids)} 通')

    total, batch, mails = 0, [], 0
    for n, uid in enumerate(uids, 1):
        _, msgdata = imap.uid('fetch', uid, '(BODY.PEEK[])')
        raw = next((p[1] for p in msgdata if isinstance(p, tuple)), None)
        if not raw:
            continue
        msg = email.message_from_bytes(raw)
        items = to_kakera(msg, f'yahoo-{args.folder}-{uid.decode()}')
        if not items:
            continue
        mails += 1
        if not args.send:
            if mails <= 5:
                print(f'\n--- {decode_header(msg.get("Subject"))}（{len(items)}段落）')
                for it in items[:3]:
                    print('・' + it['body'][:120].replace('\n', ' '))
            continue
        batch.extend(items)
        if len(batch) >= 200:
            total += send(url, key, token, batch)
            batch = []
            print(f'  {n}/{len(uids)} 通目まで…（沈めた段落 {total}）')
    if args.send and batch:
        total += send(url, key, token, batch)
    imap.logout()

    if args.send:
        print(f'\n沈めた段落 {total} 個（メール {mails} 通）。すでに入っていた分は飛ばした。')
        print('アプリを開くと、端末で意味を計算して波紋や検索に出るようになる。')
    else:
        print(f'\n見るだけ：沈む予定のメール {mails} 通。よければ --send を付けてもう一度。')


if __name__ == '__main__':
    main()
