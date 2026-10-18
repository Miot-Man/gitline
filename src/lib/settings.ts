import { useEffect, useState } from 'react';
import type { LanguageRule } from './highlight';
import type { MergeMethod } from '../types';

// App-wide preferences kept in localStorage. Git identity lives in git config instead.
export type PullMode = 'ff' | 'ff-only' | 'rebase';
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  autoFetchMinutes: number; // 0 turns auto-fetch off
  pullMode: PullMode;
  commitTemplate: string; // used when git's commit.template isn't set
  theme: Theme;
  editor: string; // command used for "Open in editor"; empty = auto-detect VS Code
  notifyPushes: boolean; // tell me when teammates push
  autoUpdate: boolean; // check GitHub Releases for new versions
  syntaxHighlighting: boolean;
  syntaxRules: LanguageRule[]; // the user's language choices per file type
  mergeMethod: MergeMethod; // the last way a pull request was merged
}

const DEFAULTS: Settings = { autoFetchMinutes: 5, pullMode: 'ff', commitTemplate: '', theme: 'system', editor: '', notifyPushes: true, autoUpdate: true, syntaxHighlighting: true, syntaxRules: [], mergeMethod: 'merge' };
const EVENT = 'gitline-settings';

export function loadSettings(): Settings {
  const s = { ...DEFAULTS };
  try {
    Object.assign(s, JSON.parse(localStorage.getItem('settings') ?? '{}'));
  } catch {}
  // pullMode used to be stored on its own.
  const legacy = localStorage.getItem('pullMode');
  if (legacy && !localStorage.getItem('settings')) s.pullMode = legacy as PullMode;
  return s;
}

export function saveSettings(patch: Partial<Settings>) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem('settings', JSON.stringify(next));
  window.dispatchEvent(new Event(EVENT));
}

export function useSettings(): Settings {
  const [s, setS] = useState(loadSettings);
  useEffect(() => {
    const on = () => setS(loadSettings());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return s;
}

// Strips git-style comment lines and surrounding blank lines from a template.
export function cleanTemplate(t: string | null | undefined) {
  return (t ?? '')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();
}

// Keyboard shortcut labels in the platform's style: ⌘Z on macOS, Ctrl+Z elsewhere.
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const shortcut = (key: string, shift = false) => (isMac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);
