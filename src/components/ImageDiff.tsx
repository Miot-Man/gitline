import { useEffect, useState } from 'react';
import { git } from '../api';

// Which version of the image each side shows: a commit, ':' for the index, or null for the working copy.
export interface ImageSide {
  rev: string | null;
  path: string;
}

interface Props {
  repo: string;
  before: ImageSide | null; // null when the image was added
  after: ImageSide | null; // null when the image was deleted
  version: number;
}

interface Loaded {
  url: string;
  size: number;
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

export function ImageDiff({ repo, before, after, version }: Props) {
  const [a, setA] = useState<Loaded | null | undefined>(undefined);
  const [b, setB] = useState<Loaded | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const load = (side: ImageSide | null) => (side ? git<Loaded | null>('imageData', repo, side.rev, side.path) : Promise.resolve(null));
    Promise.all([load(before), load(after)]).then(([x, y]) => {
      if (!alive) return;
      setA(x);
      setB(y);
    });
    return () => {
      alive = false;
    };
  }, [repo, before?.rev, before?.path, after?.rev, after?.path, version]);

  return (
    <div className="image-diff">
      <ImagePane label="Before" img={a} />
      <ImagePane label="After" img={b} />
    </div>
  );
}

function ImagePane({ label, img }: { label: string; img: Loaded | null | undefined }) {
  const [dims, setDims] = useState<string | null>(null);
  return (
    <div className={`image-pane ${label.toLowerCase()}`}>
      <div className="conflict-label">
        {label}
        {img && ` · ${dims ?? ''}${dims ? ' · ' : ''}${kb(img.size)}`}
      </div>
      <div className="image-frame">
        {img === undefined ? (
          <span className="muted">Loading…</span>
        ) : img === null ? (
          <span className="muted">{label === 'Before' ? 'New image' : 'Deleted'}</span>
        ) : (
          <img src={img.url} alt={label} onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)} />
        )}
      </div>
    </div>
  );
}
