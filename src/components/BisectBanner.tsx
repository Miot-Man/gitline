import type { BisectState } from '../types';

interface Props {
  state: BisectState;
  head: string | null; // the commit being tested
  subject: (sha: string) => string;
  onMark: (verdict: 'good' | 'bad' | 'skip') => void;
  onShow: (sha: string) => void;
  onStop: () => void;
}

// Shown over the graph while `git bisect` narrows down which commit introduced a problem.
export function BisectBanner({ state, head, subject, onMark, onShow, onStop }: Props) {
  if (state.done) {
    return (
      <div className="bisect-banner done">
        {state.firstBad ? (
          <span>
            First bad commit: <code>{state.firstBad.slice(0, 7)}</code> {subject(state.firstBad)}
          </span>
        ) : (
          <span>{state.message}</span>
        )}
        <span className="bisect-actions">
          {state.firstBad && (
            <button className="btn btn-xs" onClick={() => onShow(state.firstBad!)}>
              Show
            </button>
          )}
          <button className="btn btn-xs btn-primary" onClick={onStop}>
            Finish
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="bisect-banner">
      <span>
        <b>Bisecting.</b> Testing <code>{head?.slice(0, 7) ?? '…'}</code>
        {state.steps != null && <> · about {state.steps} more step{state.steps === 1 ? '' : 's'}</>}. Try it, then say how it went:
      </span>
      <span className="bisect-actions">
        <button className="btn btn-xs btn-stage" onClick={() => onMark('good')}>
          Good
        </button>
        <button className="btn btn-xs btn-danger" onClick={() => onMark('bad')}>
          Bad
        </button>
        <button className="btn btn-xs" onClick={() => onMark('skip')}>
          Skip
        </button>
        <button className="btn btn-xs" onClick={onStop}>
          Stop
        </button>
      </span>
    </div>
  );
}
