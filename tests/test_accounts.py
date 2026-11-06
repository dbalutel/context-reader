"""Closed sign-ups, sign-in throttling, add-user, and passkeys (with a software authenticator)."""
import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault('READER_DATA', tempfile.mkdtemp())
import server  # noqa: E402
from test_server import Client  # noqa: E402
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url as b64  # noqa: E402


class SoftAuthenticator:
    """A passkey on a pretend device: makes real WebAuthn responses signed with its own P-256 key."""

    def __init__(self, rp_id, origin):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred_id, self.rp_id, self.origin, self.count = os.urandom(16), rp_id, origin, 0

    def _auth_data(self, attested):
        self.count += 1
        flags = 0x01 | 0x04 | (0x40 if attested else 0)  # user present, user verified, (key attached)
        data = hashlib.sha256(self.rp_id.encode()).digest() + bytes([flags]) + self.count.to_bytes(4, 'big')
        if attested:
            n = self.key.public_key().public_numbers()
            cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, 'big'), -3: n.y.to_bytes(32, 'big')})
            data += bytes(16) + len(self.cred_id).to_bytes(2, 'big') + self.cred_id + cose
        return data

    def _client_data(self, kind, options, origin):
        return json.dumps({'type': kind, 'challenge': options['challenge'], 'origin': origin or self.origin}).encode()

    def create(self, options, origin=None):
        client = self._client_data('webauthn.create', options, origin)
        att = cbor2.dumps({'fmt': 'none', 'attStmt': {}, 'authData': self._auth_data(True)})
        return {'id': b64(self.cred_id), 'rawId': b64(self.cred_id), 'type': 'public-key',
                'response': {'clientDataJSON': b64(client), 'attestationObject': b64(att)}}

    def get(self, options, origin=None):
        client = self._client_data('webauthn.get', options, origin)
        data = self._auth_data(False)
        sig = self.key.sign(data + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
        return {'id': b64(self.cred_id), 'rawId': b64(self.cred_id), 'type': 'public-key',
                'response': {'clientDataJSON': b64(client), 'authenticatorData': b64(data), 'signature': b64(sig)}}


class AccountsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for d in (server.BOOKS, server.COVERS):
            d.mkdir(parents=True, exist_ok=True)
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        port = cls.httpd.server_address[1]
        cls.base, cls.origin = f'http://127.0.0.1:{port}', f'http://127.0.0.1:{port}'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        server.FAILS.clear()
        server.SIGNUPS = True

    def tearDown(self):
        server.FAILS.clear()
        server.SIGNUPS = True

    def signed_in(self, name):
        c = Client(self.base)
        code, body, _ = c.req('POST', '/api/auth/register', {'name': name, 'password': 'secret1'})
        self.assertEqual(code, 200, body)
        return c

    def add_passkey(self, c):
        device = SoftAuthenticator('127.0.0.1', self.origin)
        code, options, _ = c.req('POST', '/api/auth/passkey-options')
        self.assertEqual(code, 200)
        self.assertEqual(options['authenticatorSelection']['residentKey'], 'required')
        self.assertEqual(options['authenticatorSelection']['userVerification'], 'required')
        code, body, _ = c.req('POST', '/api/auth/passkey-add', {'credential': device.create(options), 'name': 'iPhone'})
        self.assertEqual(code, 200, body)
        return device, body['user']

    def passkey_login(self, device, origin=None):
        c = Client(self.base)
        code, options, _ = c.req('POST', '/api/auth/passkey-login-options')
        self.assertEqual(code, 200)
        code, body, _ = c.req('POST', '/api/auth/passkey-login', {'credential': device.get(options, origin)})
        return c, code, body, options

    def test_closed_signups(self):
        server.SIGNUPS = False
        c = Client(self.base)
        self.assertFalse(c.req('GET', '/api/config')[1]['signups'])
        code, body, _ = c.req('POST', '/api/auth/register', {'name': 'Mallory', 'password': 'secret1'})
        self.assertEqual(code, 403)
        self.assertIn('Ask the person', body['error'])
        self.assertNotIn('mallory', server.load_json(server.USERS))

    def test_failed_sign_ins_are_throttled_per_ip(self):
        self.signed_in('Tess')
        c = Client(self.base)
        with mock.patch('time.sleep'):
            for _ in range(server.MAX_FAILS):
                self.assertEqual(c.req('POST', '/api/auth/login', {'name': 'Tess', 'password': 'wrong'})[0], 401)
        code, body, _ = c.req('POST', '/api/auth/login', {'name': 'Tess', 'password': 'secret1'})
        self.assertEqual(code, 429, 'even the right password waits once an IP is throttled')
        # Caddy's X-Forwarded-For (last entry) is the client address, so another client is not affected
        code, _, _ = c.req('POST', '/api/auth/login', {'name': 'Tess', 'password': 'secret1'},
                           {'X-Forwarded-For': '127.0.0.1, 203.0.113.7'})
        self.assertEqual(code, 200)
        # behind Cloudflare, Caddy passes the visitor as X-Real-IP
        code, _, _ = c.req('POST', '/api/auth/login', {'name': 'Tess', 'password': 'secret1'},
                           {'X-Real-IP': '198.51.100.9', 'X-Forwarded-For': '127.0.0.1'})
        self.assertEqual(code, 200)

    def test_add_user_command(self):
        with mock.patch('getpass.getpass', side_effect=['secret1', 'secret1']), mock.patch('builtins.print'):
            server.add_user('Olga')
        self.assertTrue(server.check_password(server.load_json(server.USERS)['olga'], 'secret1'))
        with mock.patch('getpass.getpass', side_effect=['secret1', 'other12']), self.assertRaises(SystemExit):
            server.add_user('Ivan')
        self.assertNotIn('ivan', server.load_json(server.USERS))
        with self.assertRaises(SystemExit):
            server.add_user('Olga')  # exists already

    def test_passkey_sign_in(self):
        c = self.signed_in('Pia')
        device, user = self.add_passkey(c)
        self.assertEqual([(p['name'], p['id']) for p in user['passkeys']], [('iPhone', b64(device.cred_id))])
        stored = server.load_json(server.USERS)['pia']['passkeys'][0]
        self.assertNotIn('key', user['passkeys'][0], 'public keys stay on the server')

        new, code, body, _ = self.passkey_login(device)
        self.assertEqual((code, body['user']['name']), (200, 'Pia'))
        self.assertEqual(new.req('GET', '/api/auth/me')[0], 200, 'the passkey sign-in starts a session')
        after = server.load_json(server.USERS)['pia']['passkeys'][0]
        self.assertGreater(after['count'], stored['count'])
        self.assertIn('lastUsed', after)

        # the browser is told not to add this device twice
        code, options, _ = c.req('POST', '/api/auth/passkey-options')
        self.assertEqual(options['excludeCredentials'][0]['id'], b64(device.cred_id))

    def test_passkey_response_cannot_be_replayed(self):
        c = self.signed_in('Rex')
        device, _ = self.add_passkey(c)
        _, code, _, options = self.passkey_login(device)
        self.assertEqual(code, 200)
        replay = device.get(options)  # a fresh signature over a challenge that was already used
        code, body, _ = Client(self.base).req('POST', '/api/auth/passkey-login', {'credential': replay})
        self.assertEqual(code, 400)
        self.assertIn('expired', body['error'])

    def test_passkey_from_another_site_is_refused(self):
        c = self.signed_in('Sid')
        device, _ = self.add_passkey(c)
        _, code, _, _ = self.passkey_login(device, origin='https://evil.example')
        self.assertEqual(code, 401)

    def test_unknown_or_removed_passkey_is_refused(self):
        _, code, body, _ = self.passkey_login(SoftAuthenticator('127.0.0.1', self.origin))
        self.assertEqual(code, 401)
        self.assertIn("isn't set up here", body['error'])

        c = self.signed_in('Uma')
        device, user = self.add_passkey(c)
        code, body, _ = c.req('POST', '/api/auth/passkey-remove', {'id': user['passkeys'][0]['id']})
        self.assertEqual((code, body['user']['passkeys']), (200, []))
        self.assertEqual(self.passkey_login(device)[1], 401)

    def test_challenges_are_bound_to_their_purpose_and_account(self):
        a, b = self.signed_in('Val'), self.signed_in('Wes')
        device = SoftAuthenticator('127.0.0.1', self.origin)
        options = a.req('POST', '/api/auth/passkey-options')[1]
        code, _, _ = b.req('POST', '/api/auth/passkey-add', {'credential': device.create(options)})
        self.assertEqual(code, 400, "Wes can't use the challenge issued to Val")
        login_options = Client(self.base).req('POST', '/api/auth/passkey-login-options')[1]
        self.assertEqual(a.req('POST', '/api/auth/passkey-add', {'credential': device.create(login_options)})[0], 400)

        self.assertEqual(Client(self.base).req('POST', '/api/auth/passkey-options')[0], 401, 'adding needs a session')
        self.assertEqual(a.req('POST', '/api/auth/passkey-add', {'credential': 'nope'})[0], 400)

    def test_tampered_signature_is_refused(self):
        c = self.signed_in('Xia')
        device, _ = self.add_passkey(c)
        options = Client(self.base).req('POST', '/api/auth/passkey-login-options')[1]
        cred = device.get(options)
        sig = bytearray(base64url_to_bytes(cred['response']['signature']))
        sig[-1] ^= 1
        cred['response']['signature'] = b64(bytes(sig))
        self.assertEqual(Client(self.base).req('POST', '/api/auth/passkey-login', {'credential': cred})[0], 401)


if __name__ == '__main__':
    unittest.main()
