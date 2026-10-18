import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Check, ChevronDown, CircleDot, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquare, MoreHorizontal, X } from 'lucide-react';
import type { MergeMethod, PrReview, PullRequestDetails } from '../types';
import { git } from '../api';
import { authorColor, formatDate, relativeTime } from '../lib/format';
import { saveSettings, shortcut, useSettings } from '../lib/settings';
import { Avatar, useUI } from './ui';

const MERGE_LABELS: Record<MergeMethod, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };
const MERGE_SHORT: Record<MergeMethod, string> = { merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' };
const STATE_LABEL = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const REVIEW_LABEL: Record<PrReview['state'], string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed',
  DISMISSED: 'review dismissed',
  PENDING: 'review pending',
};

// PR bodies and comments are Markdown written by other people: render it, then sanitize the HTML.
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true, async: false })), [text]);
  // Links open in the browser instead of navigating the app's window.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    if (/^https?:/.test(a.href)) window.open(a.href);
  };
  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Why the merge button can't do its job, or a warning worth showing beside it.
function mergeNote(d: PullRequestDetails): { text: string; blocking: boolean } | null {
  if (d.state === 'draft') return { text: 'This is a draft. Mark it ready for review to merge it.', blocking: true };
  if (d.mergeable === false) return { text: `This branch has conflicts with ${d.base}. Resolve them before merging.`, blocking: true };
  if (d.mergeable === null) return { text: 'GitHub is still checking whether this can be merged.', blocking: false };
  if (d.mergeState === 'blocked') return { text: 'Merging is blocked until required reviews or checks pass.', blocking: false };
  if (d.mergeState === 'behind') return { text: `This branch is behind ${d.base}.`, blocking: false };
  if (d.mergeState === 'unstable') return { text: 'Some checks are failing or still running.', blocking: false };
  return null;
}

// Each reviewer's latest say: approvals and change requests outrank plain review comments.
function latestReviews(reviews: PrReview[]) {
  const by = new Map<string, PrReview>();
  for (const r of reviews) {
    if (r.state === 'PENDING') continue;
    const cur = by.get(r.author);
    if (!cur || r.state !== 'COMMENTED' || cur.state === 'COMMENTED') by.set(r.author, r);
  }
  return [...by.values()];
}

interface Props {
  repo: string;
  number: number;
  version: number; // bumped whenever the PR list reloads
  // Runs a GitHub action with the app's busy state and toasts; resolves to whether it worked.
  act: (label: string, fn: () => Promise<unknown>, success: string) => Promise<boolean>;
  onSelectSha: (sha: string) => void;
  onCheckout: () => void;
  onClose: () => void;
}

export function PrPanel({ repo, number, version, act, onSelectSha, onCheckout, onClose }: Props) {
  const ui = useUI();
  const { mergeMethod } = useSettings();
  const [d, setD] = useState<PullRequestDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [comment, setComment] = useState('');
  const [editingBody, setEditingBody] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    git<PullRequestDetails>('ghPrDetails', repo, number)
      .then((r) => alive && setD(r))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, number, version]);

  // A different PR starts from a clean slate.
  useEffect(() => {
    setD(null);
    setComment('');
    setEditingBody(null);
  }, [number]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !e.defaultPrevented && !t.closest('input, textarea, .modal')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const header = (
    <div className="panel-header">
      <span className="pr-panel-num">
        <GitPullRequest size={14} /> Pull request #{number}
        {d && <span className={`pr-state ${d.state}`}>{STATE_LABEL[d.state]}</span>}
      </span>
      <span>
        {d?.number === number && (
          <button className="icon-btn" title="More actions" aria-label="More pull request actions" onClick={(e) => moreMenu(e)}>
            <MoreHorizontal size={14} />
          </button>
        )}
        <button className="icon-btn" title="Close (Esc)" aria-label="Close pull request" onClick={onClose}>
          <X size={14} />
        </button>
      </span>
    </div>
  );

  if (!d || d.number !== number)
    return (
      <div className="commit-panel pr-panel">
        {header}
        <div className="panel-empty">{error ?? 'Loading…'}</div>
      </div>
    );

  // Every action reloads the PR list afterwards, and with it this panel (through `version`).
  const done = act;
  const own = !!d.viewer && d.viewer === d.author;
  const isOpen = d.state === 'open' || d.state === 'draft';
  const note = isOpen ? mergeNote(d) : null;

  const merge = async (method: MergeMethod) => {
    saveSettings({ mergeMethod: method });
    const ok = await ui.confirm({
      title: `${MERGE_SHORT[method]} #${d.number}?`,
      message: (
        <>
          {MERGE_LABELS[method]}: <b>{d.head}</b> into <b>{d.base}</b> on GitHub.
          {deleteBranch && <> Then delete the {d.head} branch.</>}
        </>
      ),
      confirmText: MERGE_SHORT[method],
    });
    if (ok) done('Merging…', () => git('ghMergePr', repo, d.number, method, deleteBranch), `Merged #${d.number}`);
  };
  const mergeMenu = (e: React.MouseEvent) =>
    ui.menu(
      e,
      (Object.keys(MERGE_LABELS) as MergeMethod[]).map((m) => ({ label: `${m === mergeMethod ? '✓ ' : '   '}${MERGE_LABELS[m]}`, onClick: () => merge(m) }))
    );

  const approve = async () => {
    if (await ui.confirm({ title: `Approve #${d.number}?`, message: `Approve ${d.author}'s changes on GitHub.`, confirmText: 'Approve' }))
      done('Approving…', () => git('ghReviewPr', repo, d.number, 'approve', ''), `Approved #${d.number}`);
  };
  const requestChanges = async () => {
    const body = await ui.prompt({ title: `Request changes on #${d.number}`, label: 'What needs to change', multiline: true, confirmText: 'Request changes' });
    if (body) done('Sending review…', () => git('ghReviewPr', repo, d.number, 'request-changes', body), 'Requested changes');
  };
  const reviewMenu = (e: React.MouseEvent) =>
    ui.menu(e, [
      { label: 'Approve…', onClick: approve },
      { label: 'Request changes…', onClick: requestChanges },
    ]);

  const editTitle = async () => {
    const title = await ui.prompt({ title: `Edit the title of #${d.number}`, initial: d.title, confirmText: 'Save' });
    if (title && title !== d.title) done('Saving…', () => git('ghEditPr', repo, d.number, { title }), 'Saved the title');
  };
  const saveBody = async () => {
    if (editingBody === null) return;
    if (await done('Saving…', () => git('ghEditPr', repo, d.number, { body: editingBody }), 'Saved the description')) setEditingBody(null);
  };
  const close = async () => {
    if (await ui.confirm({ title: `Close #${d.number}?`, message: 'It can be reopened later.', confirmText: 'Close pull request', danger: true }))
      done('Closing…', () => git('ghClosePr', repo, d.number), `Closed #${d.number}`);
  };
  const sendComment = async () => {
    const body = comment.trim();
    if (body && (await done('Commenting…', () => git('ghCommentPr', repo, d.number, body), 'Comment added'))) setComment('');
  };
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    ui.toast('Copied to clipboard', 'success');
  };

  function moreMenu(e: React.MouseEvent) {
    if (!d) return;
    ui.menu(e, [
      { label: 'Show branch in graph', onClick: () => onSelectSha(d.sha) },
      { label: `Checkout ${d.head}`, onClick: onCheckout },
      'sep',
      ...(isOpen
        ? [
            { label: 'Edit title…', onClick: editTitle },
            { label: 'Edit description', onClick: () => setEditingBody(d.body) },
            d.state === 'draft'
              ? { label: 'Mark ready for review', onClick: () => done('Updating…', () => git('ghReadyPr', repo, d.number, false), `#${d.number} is ready for review`) }
              : { label: 'Convert to draft', onClick: () => done('Updating…', () => git('ghReadyPr', repo, d.number, true), `#${d.number} is a draft`) },
            { label: 'Close pull request…', onClick: close, danger: true },
          ]
        : d.state === 'closed'
          ? [{ label: 'Reopen pull request', onClick: () => done('Reopening…', () => git('ghReopenPr', repo, d.number), `Reopened #${d.number}`) }]
          : []),
      'sep',
      { label: 'Open on GitHub', onClick: () => window.open(d.url) },
      { label: 'Copy link', onClick: () => copy(d.url) },
    ]);
  }

  const reviews = latestReviews(d.reviews);
  const timeline = [
    ...d.comments.map((c) => ({ ...c, verb: 'commented', key: `c${c.time}${c.author}` })),
    ...d.reviews.filter((r) => r.state !== 'PENDING' && (r.body || r.state !== 'COMMENTED')).map((r) => ({ ...r, verb: REVIEW_LABEL[r.state], key: `r${r.time}${r.author}` })),
  ].sort((a, b) => a.time - b.time);
  const StateIcon = d.state === 'merged' ? GitMerge : d.state === 'closed' ? GitPullRequestClosed : d.state === 'draft' ? GitPullRequestDraft : GitPullRequest;

  return (
    <div className="commit-panel pr-panel">
      {header}
      <div className="pr-scroll">
        <div className="commit-message">
          <div className="commit-subject pr-title">
            <StateIcon size={15} className={`pr-state-icon ${d.state}`} /> {d.title}
          </div>
          <div className="pr-meta">
            <Avatar name={d.author} color={authorColor(d.author)} size={18} />
            <span>
              <b>{d.author}</b> wants to merge <code>{d.head}</code> into <code>{d.base}</code>
            </span>
          </div>
          <div className="pr-meta muted">
            <span title={formatDate(d.created)}>opened {relativeTime(d.created)}</span>
            <span>·</span>
            <span>
              {d.commits} commit{d.commits === 1 ? '' : 's'}, {d.files} file{d.files === 1 ? '' : 's'}
            </span>
            <span className="st-add">+{d.additions}</span>
            <span className="st-del">−{d.deletions}</span>
          </div>
        </div>

        {isOpen && (
          <div className="pr-actions">
            <div className="pr-action-row">
              <span className="pr-split">
                <button className="btn btn-sm btn-primary" disabled={!!note?.blocking} onClick={() => merge(mergeMethod)}>
                  <GitMerge size={13} /> {MERGE_SHORT[mergeMethod]}
                </button>
                <button className="btn btn-sm btn-primary pr-split-caret" disabled={!!note?.blocking} onClick={mergeMenu} aria-label="Merge options" title="Merge options">
                  <ChevronDown size={13} />
                </button>
              </span>
              {!own && (
                <button className="btn btn-sm" onClick={reviewMenu}>
                  Review <ChevronDown size={13} />
                </button>
              )}
              {d.state === 'draft' && (
                <button className="btn btn-sm" onClick={() => done('Updating…', () => git('ghReadyPr', repo, d.number, false), `#${d.number} is ready for review`)}>
                  Ready for review
                </button>
              )}
            </div>
            {!d.fork && (
              <label className="pr-check">
                <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> Delete {d.head} after merging
              </label>
            )}
            {note && <div className={`pr-note${note.blocking ? ' blocking' : ''}`}>{note.text}</div>}
          </div>
        )}

        <div className="pr-section">
          <div className="pr-section-title">
            Description
            {isOpen && editingBody === null && (
              <a className="link pr-edit" onClick={() => setEditingBody(d.body)}>
                Edit
              </a>
            )}
          </div>
          {editingBody !== null ? (
            <div className="pr-edit-body">
              <textarea rows={8} value={editingBody} autoFocus onChange={(e) => setEditingBody(e.target.value)} />
              <div className="pr-action-row">
                <button className="btn btn-sm btn-primary" onClick={saveBody}>
                  Save
                </button>
                <button className="btn btn-sm" onClick={() => setEditingBody(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : d.body.trim() ? (
            <Markdown text={d.body} />
          ) : (
            <div className="muted">No description.</div>
          )}
        </div>

        {d.checks.length > 0 && (
          <div className="pr-section">
            <div className="pr-section-title">
              Checks <span className={`pr-checks ${d.checksState ?? ''}`} />
            </div>
            {d.checks.map((c, i) => (
              <div key={i} className="pr-row" title={c.workflow ? `${c.workflow} / ${c.name}` : c.name}>
                <span className={`pr-checks ${c.state}`} />
                <span className="pr-row-label">
                  {c.name}
                  {c.workflow && <span className="muted"> · {c.workflow}</span>}
                </span>
                {c.url && (
                  <button className="icon-btn" title="Open on GitHub" onClick={() => window.open(c.url)}>
                    <ExternalLink size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {(reviews.length > 0 || d.requested.length > 0) && (
          <div className="pr-section">
            <div className="pr-section-title">Reviewers</div>
            {reviews.map((r) => (
              <div key={r.author} className="pr-row">
                <Avatar name={r.author} color={authorColor(r.author)} size={18} />
                <span className="pr-row-label">{r.author}</span>
                <span className={`pr-review ${r.state.toLowerCase()}`}>
                  {r.state === 'APPROVED' && <Check size={12} />}
                  {REVIEW_LABEL[r.state]}
                </span>
              </div>
            ))}
            {d.requested
              .filter((n) => !reviews.some((r) => r.author === n))
              .map((n) => (
                <div key={n} className="pr-row">
                  <Avatar name={n} color={authorColor(n)} size={18} />
                  <span className="pr-row-label">{n}</span>
                  <span className="pr-review pending">
                    <CircleDot size={12} /> awaiting review
                  </span>
                </div>
              ))}
          </div>
        )}

        <div className="pr-section">
          <div className="pr-section-title">Conversation</div>
          {timeline.length === 0 && <div className="muted">No comments yet.</div>}
          {timeline.map((t) => (
            <div key={t.key} className="pr-comment">
              <div className="pr-comment-head">
                <Avatar name={t.author} color={authorColor(t.author)} size={18} />
                <b>{t.author}</b>
                <span className="muted">
                  {t.verb} <span title={formatDate(t.time)}>{relativeTime(t.time)}</span>
                </span>
              </div>
              {t.body.trim() && <Markdown text={t.body} />}
            </div>
          ))}
        </div>
      </div>

      <div className="pr-compose">
        <textarea
          rows={2}
          placeholder="Leave a comment (Markdown)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              sendComment();
            }
          }}
        />
        <button className="btn btn-sm" disabled={!comment.trim()} onClick={sendComment} title={`Comment (${shortcut('Enter')})`}>
          <MessageSquare size={13} /> Comment
        </button>
      </div>
    </div>
  );
}
