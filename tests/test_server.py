"""Server self-check: python3 -m unittest discover tests  (no network needed)."""
import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ['READER_DATA'] = tempfile.mkdtemp()
import server  # noqa: E402


class Client:
    """One browser: keeps its own session cookie."""

    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def req(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=headers or {})
        try:
            with self.opener.open(r) as res:
                raw = res.read()
                is_json = res.headers.get_content_type() == 'application/json' and raw
                return res.status, (json.loads(raw) if is_json else raw), res.headers
        except urllib.error.HTTPError as e:
            raw = e.read()
            e.close()
            return e.code, (json.loads(raw) if raw else None), e.headers

    def upload(self, name='My Book.epub', data=b'PK\x03\x04 fake epub'):
        return self.req('POST', '/api/books', data, {'X-Filename': urllib.request.quote(name)})


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for d in (server.BOOKS, server.COVERS):
            d.mkdir(parents=True, exist_ok=True)
        # a book uploaded before accounts existed: the first account adopts it
        server.save_lib({'0123456789abcdef': {'id': '0123456789abcdef', 'filename': 'old.epub', 'file': 'old.epub',
                                              'size': 1, 'added': 1, 'title': 'Old', 'author': '', 'hasCover': False}})
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.ann = Client(cls.base)
        code, body, headers = cls.ann.req('POST', '/api/auth/register', {'name': 'Ann', 'password': 'secret1'})
        assert code == 200, body
        cls.cookie_header = headers['Set-Cookie']

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_book_lifecycle(self):
        c = self.ann
        code, meta, _ = c.upload()
        self.assertEqual(code, 201)
        self.assertEqual(meta['title'], 'My Book')
        book_id = meta['id']

        code, meta, _ = c.req('PATCH', f'/api/books/{book_id}', {
            'title': 'Real Title', 'targetLang': 'de', 'fraction': 0.5, 'hasCover': 'yes',
            'file': '../../etc/passwd', 'owner': 'someone-else'})
        self.assertEqual(code, 200)
        self.assertEqual((meta['title'], meta['targetLang'], meta['fraction']), ('Real Title', 'de', 0.5))
        self.assertFalse(meta['hasCover'], 'wrong types are ignored')
        self.assertTrue(meta['file'].startswith(book_id), 'file is not editable')
        self.assertNotEqual(meta['owner'], 'someone-else', 'owner is not editable')

        code, body, _ = c.req('GET', f'/api/books/{book_id}/file')
        self.assertEqual((code, body), (200, b'PK\x03\x04 fake epub'))

        self.assertEqual(c.req('PUT', f'/api/books/{book_id}/cover', b'not an image')[0], 415)
        self.assertEqual(c.req('PUT', f'/api/books/{book_id}/cover', b'\x89PNG....')[0], 204)
        code, _, headers = c.req('GET', f'/api/books/{book_id}/cover')
        self.assertEqual((code, headers['Content-Type']), (200, 'image/png'))

        code, books, _ = c.req('GET', '/api/books')
        self.assertIn(book_id, [b['id'] for b in books])

        self.assertEqual(c.req('DELETE', f'/api/books/{book_id}')[0], 204)
        self.assertEqual(c.req('GET', f'/api/books/{book_id}/file')[0], 404)
        self.assertFalse(any(server.BOOKS.glob(f'{book_id}*')))

    def test_accounts(self):
        self.assertIn('HttpOnly', self.cookie_header)
        self.assertIn('SameSite=Lax', self.cookie_header)
        anon = Client(self.base)
        self.assertEqual(anon.req('GET', '/api/books')[0], 401)
        self.assertEqual(anon.req('POST', '/api/lookup', {'text': 'x', 'target': 'de'})[0], 401)
        self.assertEqual(anon.req('GET', '/api/auth/me')[0], 401)
        self.assertEqual(anon.req('GET', '/api/config')[0], 200)

        self.assertEqual(anon.req('POST', '/api/auth/register', {'name': 'ann', 'password': 'whatever1'})[0], 409)
        self.assertEqual(anon.req('POST', '/api/auth/register', {'name': '<script>', 'password': 'whatever1'})[0], 400)
        self.assertEqual(anon.req('POST', '/api/auth/register', {'name': 'Bob', 'password': '123'})[0], 400)
        self.assertEqual(anon.req('POST', '/api/auth/login', {'name': 'Ann', 'password': 'wrong'})[0], 401)

        code, body, _ = anon.req('POST', '/api/auth/login', {'name': 'ANN', 'password': 'secret1'})
        self.assertEqual((code, body['user']['name']), (200, 'Ann'))
        self.assertEqual(anon.req('GET', '/api/auth/me')[1]['user']['name'], 'Ann')
        self.assertEqual(anon.req('POST', '/api/auth/logout')[0], 204)
        self.assertEqual(anon.req('GET', '/api/auth/me')[0], 401)
        stored = json.dumps(server.load_json(server.USERS)) + json.dumps(server.load_json(server.SESSIONS))
        self.assertNotIn('secret1', stored)

    def test_libraries_are_private(self):
        code, books, _ = self.ann.req('GET', '/api/books')
        self.assertIn('0123456789abcdef', [b['id'] for b in books], 'first account adopts existing books')
        _, meta, _ = self.ann.upload('Ann only.txt', b'hello')

        bob = Client(self.base)
        self.assertEqual(bob.req('POST', '/api/auth/register', {'name': 'Bob', 'password': 'secret2'})[0], 200)
        self.assertEqual(bob.req('GET', '/api/books')[1], [])
        for method, path in (('GET', f'/api/books/{meta["id"]}'), ('GET', f'/api/books/{meta["id"]}/file'),
                             ('PATCH', f'/api/books/{meta["id"]}'), ('DELETE', f'/api/books/{meta["id"]}')):
            self.assertEqual(bob.req(method, path, {} if method == 'PATCH' else None)[0], 404, path)
        self.assertEqual(self.ann.req('GET', f'/api/books/{meta["id"]}/file')[1], b'hello')

    def test_rejects_bad_uploads(self):
        self.assertEqual(self.ann.upload('virus.exe')[0], 415)
        self.assertEqual(self.ann.upload('empty.epub', b'')[0], 413)
        code, meta, _ = self.ann.upload('../../evil.fb2.zip')
        self.assertEqual(code, 201)
        self.assertEqual(meta['file'], meta['id'] + '.fb2.zip')

    def test_ids_and_paths_are_validated(self):
        c = self.ann
        self.assertEqual(c.req('GET', '/api/books/../../server.py')[0], 404)
        self.assertEqual(c.req('GET', '/api/books/zzzz/file')[0], 404)
        self.assertEqual(c.req('GET', '/%2e%2e/server.py')[0], 404)
        code, body, headers = c.req('GET', '/')
        self.assertEqual(code, 200)
        self.assertIn("script-src 'self'", headers['Content-Security-Policy'])

    def test_lookup_keeps_lines_and_limits_targets(self):
        c = self.ann
        server.AI_ENABLED = True
        self.assertEqual(c.req('POST', '/api/lookup', {'text': '', 'target': 'de'})[0], 400)
        self.assertEqual(c.req('POST', '/api/lookup', {'text': 'hi', 'target': 'es'})[0], 400)
        self.assertEqual(c.req('POST', '/api/lookup', b'not json')[0], 400)

        calls = []

        def fake_claude(lines, context, source, target, title, author, on_partial=None):
            calls.append((lines, context, target, title))
            merged = lines == ['a', 'b', 'c', 'd']  # simulate the model merging lines
            return {
                'detected_language': 'en',
                'translation_lines': ['merged'] if merged else [f'[{target}] {l}' if l else '' for l in lines],
                'sentence_translation': f'[{target}] {context}' if context else '',
                'explanation': 'idiom: to die' if lines == ['bucket'] else '',
                'dictionary': {'lemma': 'bucket', 'part_of_speech': 'noun', 'other_senses': ['pail', 'a lot', 'x', 'y']}
                if lines == ['bucket'] else {'lemma': '', 'part_of_speech': '', 'other_senses': []},
            }
        def google_down(*a):
            raise OSError('offline')
        orig, orig_g = server.ask_claude, server.google_translate
        server.ask_claude, server.google_translate = fake_claude, google_down  # short text falls back to Claude
        server._lookups.clear()
        try:
            code, res, _ = c.req('POST', '/api/lookup', {
                'text': 'bucket', 'context': 'He kicked\nthe bucket.', 'target': 'de', 'title': 'Book'})
            code2, res2, _ = c.req('POST', '/api/lookup', {
                'text': 'First  line\r\nsecond line\n\n\n\nNew   paragraph', 'context': 'ignored', 'target': 'ru'})
            code3, res3, _ = c.req('POST', '/api/lookup', {'text': 'a\nb\nc\nd', 'target': 'ro'})
        finally:
            server.ask_claude, server.google_translate = orig, orig_g
        self.assertEqual(code, 200)
        self.assertEqual(res['translation'], '[de] bucket')
        self.assertEqual(res['contextTranslation'], '[de] He kicked the bucket.')
        self.assertEqual(res['explanation'], 'idiom: to die')
        self.assertEqual(res['definitions'], [{'pos': 'bucket · noun', 'defs': ['pail', 'a lot', 'x']}])
        self.assertEqual(calls[0][3], 'Book')

        self.assertEqual(code2, 200)
        self.assertEqual(calls[1][0], ['First line', 'second line', '', 'New paragraph'])
        self.assertEqual(calls[1][1], '', 'multi-line selections skip the sentence')
        self.assertEqual(res2['translation'], '[ru] First line\n[ru] second line\n\n[ru] New paragraph')
        self.assertIsNone(res2['contextTranslation'])
        self.assertIsNone(res2['explanation'])
        self.assertEqual(res2['definitions'], [])

        self.assertEqual((code3, res3['translation']), (200, 'merged'), 'line-count mismatch keeps the text')

    def test_short_lookup_uses_google_and_stream(self):
        c = self.ann
        gcalls = []

        def fake_google(texts, source, target):
            gcalls.append(texts)
            return [(f'<{target}> {t}', 'en') for t in texts]

        def fake_claude(lines, context, source, target, title, author, on_partial=None):
            on_partial({'translation_lines': ['Halb']})
            on_partial({'translation_lines': ['Halb fertig'], 'explanation': 'Ex'})
            return {'detected_language': 'en', 'translation_lines': ['Halb fertig.'], 'sentence_translation': '',
                    'explanation': 'Ex.', 'dictionary': {'lemma': '', 'part_of_speech': '', 'other_senses': []}}
        orig, orig_g = server.ask_claude, server.google_translate
        server.ask_claude, server.google_translate = fake_claude, fake_google
        server._lookups.clear()
        try:
            code, res, _ = c.req('POST', '/api/lookup', {'text': 'two words', 'context': 'It has two words.', 'target': 'de'})
            code2, raw, headers = c.req('POST', '/api/lookup', {'text': 'half done now', 'target': 'de', 'stream': True})
        finally:
            server.ask_claude, server.google_translate = orig, orig_g
        self.assertEqual((code, res['translation'], res['contextTranslation'], res['provider']),
                         (200, '<de> two words', '<de> It has two words.', 'Google Translate'))
        self.assertEqual(gcalls, [['two words', 'It has two words.']])
        self.assertEqual(code2, 200)
        self.assertEqual(headers.get_content_type(), 'application/x-ndjson')
        msgs = [json.loads(line) for line in raw.decode().splitlines()]
        self.assertEqual([m['partial']['translation'] for m in msgs[:-1]], ['Halb', 'Halb fertig'])
        self.assertEqual(msgs[-1]['result']['translation'], 'Halb fertig.')

    def test_lookup_without_key(self):
        server.AI_ENABLED = False
        try:
            code, body, _ = self.ann.req('POST', '/api/lookup', {'text': 'more than two words', 'target': 'de'})
        finally:
            server.AI_ENABLED = True
        self.assertEqual(code, 503)
        self.assertIn('API key', body['error'])

    def test_response_json_skips_declined_text(self):
        from types import SimpleNamespace as B
        blocks = [B(type='thinking'), B(type='text', text='{"partial'), B(type='fallback'), B(type='text', text='{"ok": 1}')]
        self.assertEqual(server.response_json(blocks), {'ok': 1})
        self.assertEqual(server.response_json([B(type='text', text='{"a": '), B(type='text', text='2}')]), {'a': 2})

    def test_parse_opds(self):
        xml = b"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
          <link rel="next" href="/ebooks/search.opds/?start_index=26"/>
          <entry><id>https://www.gutenberg.org/ebooks/author/136.opds</id><title>Authors</title></entry>
          <entry><id>https://www.gutenberg.org/ebooks/22367.opds</id><title>Die Verwandlung (German)</title><content>Franz Kafka</content></entry>
          <entry><id>https://www.gutenberg.org/ebooks/1342.opds</id><title>Pride and Prejudice</title><content>Jane Austen</content></entry>
        </feed>"""
        self.assertEqual(server.parse_opds(xml, ''), {'more': True, 'books': [
            {'id': 22367, 'title': 'Die Verwandlung', 'language': 'de', 'author': 'Franz Kafka'},
            {'id': 1342, 'title': 'Pride and Prejudice', 'language': 'en', 'author': 'Jane Austen'}]})

    def test_store_add_and_search(self):
        c = self.ann
        self.assertEqual(c.req('GET', '/api/store?lang=xx')[0], 400)
        self.assertEqual(c.req('POST', '/api/store/abc', {})[0], 404)
        self.assertEqual(Client(self.base).req('GET', '/api/store')[0], 401)

        downloads = []

        def fake_download(gid, dest):
            downloads.append(gid)
            dest.write_bytes(b'PK\x03\x04 epub')
        orig = server.download_epub, server.store_cover, server.store_search
        server.download_epub = fake_download
        server.store_cover = lambda gid: b'\xff\xd8 jpeg'
        server.store_search = lambda q, lang, page: {'more': False, 'books': [
            {'id': 98765, 'title': 'T', 'language': 'en', 'author': 'A'}, {'id': 1, 'title': 'U', 'language': 'en', 'author': ''}]}
        try:
            code, meta, _ = c.req('POST', '/api/store/98765', {'title': 'Faust', 'author': 'Goethe', 'language': 'de'})
            code2, again, _ = c.req('POST', '/api/store/98765', {'title': 'Faust'})
            _, found, _ = c.req('GET', '/api/store?q=faust&lang=de')
            _, cover, headers = c.req('GET', '/api/store/98765/cover')
        finally:
            server.download_epub, server.store_cover, server.store_search = orig
        self.assertEqual(code, 201)
        self.assertEqual((meta['title'], meta['author'], meta['language'], meta['source'], meta['hasCover']),
                         ('Faust', 'Goethe', 'de', 'gutenberg:98765', True))
        self.assertEqual((code2, again['id']), (200, meta['id']), 'adding twice returns the same book')
        self.assertEqual(downloads, [98765])
        self.assertEqual([b['owned'] for b in found['books']], [True, False])
        self.assertEqual((cover, headers['Content-Type']), (b'\xff\xd8 jpeg', 'image/jpeg'))
        self.assertEqual(c.req('GET', f'/api/books/{meta["id"]}/file')[1], b'PK\x03\x04 epub')

    def test_clean_patch_types(self):
        self.assertEqual(server.clean_patch({'fraction': True, 'hasCover': 1, 'cfi': None}), {'cfi': None})


if __name__ == '__main__':
    unittest.main()
