import { describe, expect, it } from 'vitest';
import { pairWordDiffs, wordDiff } from '../src/lib/wordDiff';
import { LANGUAGES, guessLanguage, highlight, highlightLines, languageFor, loadLanguage, markRanges, patternFor, splitHtmlLines } from '../src/lib/highlight';
import { LANGUAGE_NAMES } from '../src/lib/languageNames';
import { parseDiff } from '../src/lib/diff';

describe('wordDiff', () => {
  it('marks only the words that changed', () => {
    const [a, b] = wordDiff('set_speed(FAST_SPEED);', 'set_speed(SLOW_SPEED);')!;
    expect(a.filter((s) => s.changed).map((s) => s.text)).toEqual(['FAST_SPEED']);
    expect(b.filter((s) => s.changed).map((s) => s.text)).toEqual(['SLOW_SPEED']);
    expect(a.map((s) => s.text).join('')).toBe('set_speed(FAST_SPEED);');
  });

  it('gives up on lines that share almost nothing', () => {
    expect(wordDiff('int a = 1;', 'return foo(bar, baz) && qux;')).toBeNull();
  });

  it('pairs removed and added lines within a change block', () => {
    const d = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-let x = 1;\n-let y = 2;\n+let x = 10;\n+let y = 2;\n');
    const words = pairWordDiffs(d.hunks[0].lines);
    expect(words.get(0)!.find((s) => s.changed)!.text).toBe('1');
    expect(words.get(2)!.find((s) => s.changed)!.text).toBe('10');
  });
});

describe('highlight', () => {
  it('picks a language from the file name', () => {
    expect(languageFor('src/app.tsx')).toBe('typescript');
    expect(languageFor('firmware/main.c')).toBe('c');
    expect(languageFor('Makefile')).toBe('makefile');
    expect(languageFor('robot/robot.ino')).toBe('arduino');
    expect(languageFor('notes.unknown')).toBeNull();
  });

  it('lets user choices override the guess, by extension or exact name', () => {
    const rules = [
      { pattern: '.ino', language: 'cpp' },
      { pattern: 'Justfile', language: 'makefile' },
      { pattern: '.md', language: 'none' },
    ];
    expect(languageFor('a/b.INO', rules)).toBe('cpp');
    expect(languageFor('Justfile', rules)).toBe('makefile');
    expect(languageFor('README.md', rules)).toBeNull();
    expect(patternFor('src/Main.C')).toBe('.c');
    expect(patternFor('Makefile')).toBe('Makefile');
  });

  it('only guesses languages that exist, and offers every language', () => {
    for (const path of ['a.sh', 'a.ino', 'a.cs', 'a.v', 'a.vhd', 'a.proto', 'a.bat', 'a.rst', 'a.properties', 'a.clj', 'a.nim', 'a.erl', 'CMakeLists.txt', 'Dockerfile'])
      expect(LANGUAGE_NAMES[guessLanguage(path)!], path).toBeTruthy();
    expect(LANGUAGES.length).toBeGreaterThan(180);
    expect(LANGUAGES.find((l) => l.id === 'arduino')!.name).toBe('Arduino');
    expect(LANGUAGES.find((l) => l.id === 'typst')!.name).toBe('Typst');
  });

  it('highlights Typst, which has its own grammar', async () => {
    expect(languageFor('thesis/main.typ')).toBe('typst');
    expect(await loadLanguage('typst')).toBe(true);
    const html = highlight('#set text(size: 11pt) // body', 'typst');
    expect(html).toContain('<span class="hljs-keyword">#set</span>');
    expect(html).toContain('hljs-number');
    expect(html).toContain('hljs-comment');
    expect(highlight('= Results', 'typst')).toContain('hljs-section');
    expect(highlight('See @fig-speed and $v = d / t$.', 'typst')).toMatch(/hljs-link[\s\S]*hljs-formula/);
  });

  it('escapes the source while colouring it', async () => {
    expect(await loadLanguage('javascript')).toBe(true);
    const html = highlight('const s = "<b>";', 'javascript');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});

describe('multi-line highlighting', () => {
  it('keeps a Python docstring a string across lines', async () => {
    await loadLanguage('python');
    const lines = ['#!/usr/bin/env python3', '"""Fit the simulated motors.', '', 'Reads the log and writes from the model.', '"""', '', 'import math'];
    const html = highlightLines(lines, 'python');
    expect(html).toHaveLength(lines.length);
    // The prose inside the docstring is string-coloured, not keywords.
    expect(html[3]).toMatch(/^<span class="hljs-string">Reads the log and writes from the model\.<\/span>$/);
    expect(html[3]).not.toContain('hljs-keyword');
    expect(html[6]).toContain('<span class="hljs-keyword">import</span>');
  });

  it('closes and reopens spans at line breaks', () => {
    expect(splitHtmlLines('a<span class="x">b\nc</span>d')).toEqual(['a<span class="x">b</span>', '<span class="x">c</span>d']);
  });

  it('marks changed words inside highlighted HTML with valid nesting', () => {
    const html = 'set(<span class="hljs-number">100</span>);';
    expect(markRanges(html, [[4, 7]])).toBe('set(<span class="wd"></span><span class="hljs-number"><span class="wd">100</span></span><span class="wd"></span>);'.replace(/<span class="wd"><\/span>/g, ''));
    expect(markRanges('a &lt; b', [[2, 3]])).toBe('a <span class="wd">&lt;</span> b');
  });
});
