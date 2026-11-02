// node --test tests/*.test.mjs   — checks the plain-text chapter splitter and decoder
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitText, decodeText } from '../public/text-book.js'

test('splits chapters on headings and joins wrapped lines', () => {
    const text = 'Some intro text.\n\nCHAPTER I.\n\nIt was a dark\nand stormy night.\n\nSecond para.\n\nГлава 2\n\nТекст.'
    const ch = splitText(text)
    assert.deepEqual(ch.map(c => c.title), ['', 'CHAPTER I.', 'Глава 2'])
    assert.deepEqual(ch[1].paras, ['It was a dark and stormy night.', 'Second para.'])
})

test('one paragraph per line when the file has no blank lines', () => {
    const ch = splitText('Line one.\nLine two.\nLine three.')
    assert.equal(ch[0].paras.length, 3)
})

test('decodes UTF-8, UTF-16 BOM and legacy Cyrillic', () => {
    assert.equal(decodeText(new TextEncoder().encode('héllo')), 'héllo')
    assert.equal(decodeText(new Uint8Array([0xFF, 0xFE, 0x68, 0, 0x69, 0])), 'hi')
    assert.equal(decodeText(new Uint8Array([0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2])), 'Привет') // cp1251
})
