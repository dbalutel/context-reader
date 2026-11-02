"""The real server with stand-ins for Claude and Google, for the browser tests (no keys, no network).

Fake Claude streams a partial answer, waits FAKE_CLAUDE_DELAY seconds (so tests can see streaming and
cancel mid-answer), then answers. Fake Google answers at once. Run by tests/e2e/run.sh.
"""
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import server  # noqa: E402

DELAY = float(os.environ.get('FAKE_CLAUDE_DELAY', '0.8'))


def fake_claude(lines, context, source, target, title, author, on_partial=None):
    if on_partial:
        on_partial({'detected_language': 'en', 'translation_lines': [f'[{target}] …']})
        time.sleep(DELAY)
        on_partial({'detected_language': 'en', 'translation_lines': [f'[{target}] {lines[0][:12]}']})  # fails if aborted
    phrase = len(lines) == 1 and len(lines[0].split()) <= 3
    return {
        'detected_language': source if source != 'auto' else 'en',
        'translation_lines': [f'[{target}] {line}' if line else '' for line in lines],
        'sentence_translation': f'[{target}] {context}' if context else '',
        'explanation': f'[{target}] meaning of “{lines[0][:40]}” here.',
        'dictionary': {'lemma': lines[0].lower(), 'part_of_speech': 'phrase', 'other_senses': ['sense one', 'sense two']}
        if phrase else {'lemma': '', 'part_of_speech': '', 'other_senses': []},
    }


def fake_google(texts, source, target):
    return [(f'[{target}·g] {t}', source if source != 'auto' else 'en') for t in texts]


server.ask_claude = fake_claude
server.google_translate = fake_google
server.AI_ENABLED = True
server.main()
