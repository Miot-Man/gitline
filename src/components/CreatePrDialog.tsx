import { shortcut } from '../lib/settings';
import { useState } from 'react';

export interface NewPr {
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

interface Props {
  head: string;
  bases: string[];
  defaultBase: string;
  defaultTitle: string;
  defaultBody: string;
  needsPush: boolean;
  onCancel: () => void;
  onCreate: (pr: NewPr) => void;
}

export function CreatePrDialog({ head, bases, defaultBase, defaultTitle, defaultBody, needsPush, onCancel, onCreate }: Props) {
  const [base, setBase] = useState(defaultBase);
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody);
  const [draft, setDraft] = useState(false);
  const valid = !!title.trim() && base !== head;

  const submit = () => valid && onCreate({ base, title: title.trim(), body, draft });

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal pr-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        <div className="modal-title">
          Create pull request from <b>{head}</b>
        </div>
        <label className="field">
          <span>Merge into</span>
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Create as draft
        </label>
        {needsPush && <div className="muted pr-note">{head} isn't on GitHub yet, so it will be pushed first.</div>}
        {base === head && <div className="rebase-problem">Pick a different branch to merge into.</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={submit} title={shortcut('Enter')}>
            Create Pull Request
          </button>
        </div>
      </div>
    </div>
  );
}
