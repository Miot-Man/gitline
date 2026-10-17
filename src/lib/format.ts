export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function relativeTime(unix: number) {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return 'just now';
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];
  let unit = units[0];
  for (const u of units) if (s >= u[0]) unit = u;
  const n = Math.floor(s / unit[0]);
  return `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}

export function formatDate(unix: number) {
  const d = new Date(unix * 1000);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Stable color per author so avatars stay consistent across the app.
export function authorColor(email: string) {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 55% 45%)`;
}

export function splitPath(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

export function parseTrack(track?: string) {
  if (!track || track === 'gone') return { ahead: 0, behind: 0, gone: track === 'gone' };
  const a = track.match(/ahead (\d+)/);
  const b = track.match(/behind (\d+)/);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0, gone: false };
}

// "Today", "Yesterday", a weekday within the last week, else a short date (with the year if it isn't this year).
export function dayLabel(unix: number, now = new Date()) {
  const d = new Date(unix * 1000);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
