"""Lookups: Claude streaming, Google for short selections, the NDJSON stream and cancellation.

Runs offline: Claude and Google are replaced by fakes. Needs the anthropic SDK (requirements.txt)
for its error types.
"""
import http.client
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace as NS

import anthropic
import httpx2 as httpx  # the HTTP library anthropic 2.x is built on

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('READER_DATA', tempfile.mkdtemp())
import server  # noqa: E402

ANSWER = {
    'detected_language': 'en',
    'translation_lines': ['Это было лучшее из времён,', 'это было худшее из времён'],
    'sentence_translation': 'Это было лучшее из времён, это было худшее из времён.',
    'explanation': 'Антитеза Диккенса.',
    'dictionary': {'lemma': '', 'part_of_speech': '', 'other_senses': []},
}


# ---------- a stand-in for the Anthropic client's streaming API ----------

def text_start():
    return NS(type='content_block_start', content_block=NS(type='text'))


def fallback_start():
    return NS(type='content_block_start', content_block=NS(type='fallback'))


def delta(text):
    return NS(type='content_block_delta', delta=NS(type='text_delta', text=text))


def chunks(s, n=7):
    return [delta(s[i:i + n]) for i in range(0, len(s), n)]


class FakeStream:
    def __init__(self, events, final):
        self.events, self.final, self.closed = events, final, False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True

    def __iter__(self):
        return iter(self.events)

    def get_final_message(self):
        return self.final


class FakeClient:
    def __init__(self, stream=None, error=None):
        self.calls, self.stream, self.error = [], stream, error
        self.beta = NS(messages=NS(stream=self._stream))

    def _stream(self, **kw):
        self.calls.append(kw)
        if self.error:
            raise self.error
        return self.stream


def final(stop_reason='end_turn', blocks=None):
    return NS(stop_reason=stop_reason, content=blocks or [NS(type='text', text=json.dumps(ANSWER, ensure_ascii=False))])


def api_error(cls, status, message='boom'):
    req = httpx.Request('POST', 'https://api.anthropic.com/v1/messages')
    return cls(message, response=httpx.Response(status, request=req), body=None)


class AskClaudeTest(unittest.TestCase):
    """ask_claude: request shape, partial results while streaming, fallback, errors."""

    def setUp(self):
        self.orig = server._ai_client

    def tearDown(self):
        server._ai_client = self.orig

    def ask(self, client, on_partial=None):
        server._ai_client = client
        return server.ask_claude(['It was the best of times,', 'it was the worst of times'], 'It was the best of times.',
                                 'en', 'ru', 'A Tale of Two Cities', 'Dickens', on_partial=on_partial)

    def test_streams_partial_json_and_returns_the_answer(self):
        body = json.dumps(ANSWER, ensure_ascii=False)
        stream = FakeStream([text_start(), *chunks(body)], final())
        client = FakeClient(stream)
        partials = []
        self.assertEqual(self.ask(client, partials.append), ANSWER)
        self.assertTrue(stream.closed)

        call = client.calls[0]
        self.assertEqual(call['model'], server.AI_MODEL)
        self.assertIn('server-side-fallback-2026-07-01', call['betas'])
        self.assertEqual(call['output_config']['format'], {'type': 'json_schema', 'schema': server.LOOKUP_SCHEMA})
        self.assertIn('Russian', call['system'])
        self.assertIn('"A Tale of Two Cities" by Dickens', call['messages'][0]['content'])
        self.assertIn(json.dumps(['It was the best of times,', 'it was the worst of times']), call['messages'][0]['content'])

        # partial results grow word by word and end at the full answer
        firsts = [p['translation_lines'][0] for p in partials if p.get('translation_lines')]
        self.assertGreater(len(firsts), 2)
        self.assertTrue(all(ANSWER['translation_lines'][0].startswith(t) for t in firsts))
        self.assertEqual(partials[-1], ANSWER)

    def test_without_callback_still_streams(self):
        self.assertEqual(self.ask(FakeClient(FakeStream(chunks(json.dumps(ANSWER)), final()))), ANSWER)

    def test_fallback_discards_the_declined_models_text(self):
        good = json.dumps(ANSWER, ensure_ascii=False)
        events = [text_start(), delta('{"translation_lines": ["DECLINED'), fallback_start(), text_start(), *chunks(good)]
        blocks = [NS(type='text', text='{"translation_lines": ["DECLINED'), NS(type='fallback'), NS(type='text', text=good)]
        partials = []
        self.assertEqual(self.ask(FakeClient(FakeStream(events, final(blocks=blocks))), partials.append), ANSWER)
        after = partials[partials.index(next(p for p in partials if 'DECLINED' in json.dumps(p))) + 1:]
        self.assertTrue(after and not any('DECLINED' in json.dumps(p) for p in after))

    def test_stop_reasons(self):
        for reason, msg in (('refusal', 'No translation'), ('max_tokens', 'too long')):
            with self.subTest(reason), self.assertRaisesRegex(server.LookupFailed, msg):
                self.ask(FakeClient(FakeStream([], final(stop_reason=reason))))

    def test_api_errors_become_reader_messages(self):
        req = httpx.Request('POST', 'https://api.anthropic.com/v1/messages')
        cases = [
            (api_error(anthropic.AuthenticationError, 401), 'key was rejected'),
            (api_error(anthropic.RateLimitError, 429), 'Too many lookups'),
            (api_error(anthropic.BadRequestError, 400, 'Your credit balance is too low'), 'credits are used up'),
            (api_error(anthropic.BadRequestError, 400, 'invalid request'), 'could not be looked up'),
            (api_error(anthropic.InternalServerError, 500), 'could not be reached'),
            (anthropic.APIConnectionError(request=req), 'could not be reached'),
        ]
        for error, msg in cases:
            with self.subTest(type(error).__name__), self.assertRaisesRegex(server.LookupFailed, msg):
                self.ask(FakeClient(error=error))


class ShapeAndGoogleTest(unittest.TestCase):
    def test_shape_partial_and_final(self):
        lines = ['one', '', 'three']
        # while streaming, fewer lines than the selection is normal: align what's there
        self.assertEqual(server.shape({'translation_lines': ['eins']}, lines, 'en', final=False)['translation'], 'eins')
        self.assertEqual(server.shape({'translation_lines': ['eins', '', 'dr']}, lines, 'en', final=False)['translation'],
                         'eins\n\ndr')
        # the final answer with a different line count keeps the model's lines instead of misaligning
        self.assertEqual(server.shape({'translation_lines': ['eins drei']}, lines, 'en')['translation'], 'eins drei')
        empty = server.shape({}, lines, 'de', final=False)
        self.assertEqual((empty['translation'], empty['explanation'], empty['detected'], empty['definitions']),
                         ('', None, 'de', []))
        d = server.shape({'dictionary': {'lemma': 'run', 'part_of_speech': 'verb', 'other_senses': ['a', 'b', 'c', 'd']}},
                         ['run'], 'en')
        self.assertEqual(d['definitions'], [{'pos': 'run · verb', 'defs': ['a', 'b', 'c']}])

    def test_is_short(self):
        self.assertTrue(server.is_short('word'))
        self.assertTrue(server.is_short('  two\twords '))
        self.assertFalse(server.is_short('three words here'))
        self.assertFalse(server.is_short('one\ntwo\nthree'))

    def fake_urlopen(self, payload, seen):
        def urlopen(req, timeout):
            seen.append((req.full_url, req.data.decode(), timeout))
            return io.BytesIO(json.dumps(payload).encode())
        return urlopen

    def test_google_translate_parses_both_answer_shapes(self):
        orig = server.urllib.request.urlopen
        seen = []
        try:
            server.urllib.request.urlopen = self.fake_urlopen([['Hallo', 'en'], ['Welt', 'iw']], seen)
            self.assertEqual(server.google_translate(['hello', 'world'], 'auto', 'de'), [('Hallo', 'en'), ('Welt', 'he')])
            server.urllib.request.urlopen = self.fake_urlopen(['Hallo'], seen)
            self.assertEqual(server.google_translate(['hello'], 'en', 'de'), [('Hallo', 'en')])
            server.urllib.request.urlopen = self.fake_urlopen(['only one'], seen)
            with self.assertRaises(ValueError):
                server.google_translate(['a', 'b'], 'en', 'de')
        finally:
            server.urllib.request.urlopen = orig
        self.assertIn('sl=auto', seen[0][0])
        self.assertIn('tl=de', seen[0][0])
        self.assertEqual(seen[0][1], 'q=hello&q=world')

    def test_google_lookup(self):
        orig = server.google_translate
        try:
            server.google_translate = lambda texts, source, target: [(f'<{t}>', 'fr') for t in texts]
            r = server.google_lookup('mot', 'Un mot ici.', 'auto', 'en')
            self.assertEqual((r['translation'], r['contextTranslation'], r['detected'], r['explanation'], r['provider']),
                             ('<mot>', '<Un mot ici.>', 'fr', None, 'Google Translate'))
            self.assertIsNone(server.google_lookup('mot', '', 'fr', 'en')['contextTranslation'])

            def down(*a):
                raise OSError('offline')
            server.google_translate = down
            self.assertIsNone(server.google_lookup('mot', '', 'fr', 'en'), 'a Google failure means: ask Claude')
        finally:
            server.google_translate = orig


class StreamEndpointTest(unittest.TestCase):
    """POST /api/lookup with stream: one JSON object per line."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        conn = http.client.HTTPConnection('127.0.0.1', cls.port)
        conn.request('POST', '/api/auth/register', json.dumps({'name': 'Streamer', 'password': 'stream-pass-1'}))
        res = conn.getresponse()
        res.read()
        if res.status == 409:
            conn.request('POST', '/api/auth/login', json.dumps({'name': 'Streamer', 'password': 'stream-pass-1'}))
            res = conn.getresponse()
            res.read()
        cls.cookie = res.getheader('Set-Cookie').split(';')[0]
        conn.close()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        self.orig = server.ask_claude, server.google_translate, server.AI_ENABLED
        server.AI_ENABLED = True
        server._lookups.clear()

    def tearDown(self):
        server.ask_claude, server.google_translate, server.AI_ENABLED = self.orig

    def post(self, body):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.request('POST', '/api/lookup', json.dumps(body), {'Cookie': self.cookie})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, res.getheader('Content-Type'), raw

    def lines(self, raw):
        return [json.loads(line) for line in raw.decode().splitlines()]

    def test_error_line_and_cache_hit(self):
        def failing(*a, **kw):
            raise server.LookupFailed('This month\'s API credits are used up.')
        server.ask_claude = failing
        status, ctype, raw = self.post({'text': 'a longer selection', 'target': 'de', 'stream': True})
        self.assertEqual((status, ctype), (200, 'application/x-ndjson'))
        self.assertEqual(self.lines(raw), [{'error': 'This month\'s API credits are used up.'}])

        calls = []

        def answer(lines, *a, on_partial=None):
            calls.append(lines)
            on_partial({'translation_lines': ['eine längere']})
            return {**ANSWER, 'translation_lines': ['eine längere Auswahl']}
        server.ask_claude = answer
        first = self.lines(self.post({'text': 'a longer selection', 'target': 'de', 'stream': True})[2])
        again = self.lines(self.post({'text': 'a longer selection', 'target': 'de', 'stream': True})[2])
        self.assertEqual([list(m) for m in first], [['partial'], ['result']])
        self.assertEqual(again, [first[-1]], 'a cached lookup is answered at once')
        self.assertEqual(len(calls), 1)

    def test_short_selection_goes_to_google_even_without_a_key(self):
        server.AI_ENABLED = False
        server.ask_claude = lambda *a, **kw: self.fail('Claude must not be asked for two words')
        server.google_translate = lambda texts, source, target: [(t.upper(), source) for t in texts]
        status, _, raw = self.post({'text': 'two words', 'context': 'Just two words.', 'source': 'en',
                                    'target': 'de', 'stream': True})
        self.assertEqual(status, 200)
        result = self.lines(raw)[-1]['result']
        self.assertEqual((result['translation'], result['contextTranslation'], result['provider']),
                         ('TWO WORDS', 'JUST TWO WORDS.', 'Google Translate'))
        self.assertEqual(self.post({'text': 'three words now', 'target': 'de'})[0], 503)

    def test_closing_the_popup_stops_claude(self):
        """The reader aborts the request: the next write fails and the Claude stream is closed early."""
        progress = {'sent': 0, 'stopped_by': None}

        def slow(lines, *a, on_partial=None):
            try:
                for i in range(100):
                    on_partial({'translation_lines': ['word ' * (i + 1)]})
                    progress['sent'] += 1
                    time.sleep(0.02)
            except OSError as e:  # BrokenPipeError / ConnectionResetError from the dead socket
                progress['stopped_by'] = type(e).__name__
                raise
            return ANSWER
        server.ask_claude = slow

        body = json.dumps({'text': 'a slow long selection', 'target': 'de', 'stream': True}).encode()
        sock = socket.create_connection(('127.0.0.1', self.port))
        sock.sendall(b'POST /api/lookup HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n'
                     + f'Cookie: {self.cookie}\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body)
        got = b''
        while b'"partial"' not in got:
            got += sock.recv(4096)
        sock.close()  # what fetch's AbortController does

        deadline = time.time() + 5
        while progress['stopped_by'] is None and time.time() < deadline:
            time.sleep(0.05)
        self.assertIn(progress['stopped_by'], ('BrokenPipeError', 'ConnectionResetError'))
        self.assertLess(progress['sent'], 100, 'generation stopped early')
        self.assertEqual(server._lookups, {}, 'an aborted lookup is not cached')


if __name__ == '__main__':
    unittest.main()
