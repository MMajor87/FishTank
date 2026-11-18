import { useState, type ReactNode } from 'react';

const KEY = (id: string) => `fishtank.side.${id}`;

function readOpen(id: string): boolean {
  try {
    return localStorage.getItem(KEY(id)) !== 'closed';
  } catch {
    return true;
  }
}

/**
 * A side-panel card whose title folds it open or closed. The choice is remembered per card in
 * this browser (the same card in every Tank).
 */
export function SideCard({
  id,
  title,
  aside,
  className = '',
  children,
}: {
  id: string;
  title: ReactNode;
  /** Shown in the header even when folded (e.g. a link or the REC badge). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(id));
  const toggle = () =>
    setOpen((o) => {
      try {
        if (o) localStorage.setItem(KEY(id), 'closed');
        else localStorage.removeItem(KEY(id));
      } catch {
        /* private mode: just don't remember */
      }
      return !o;
    });
  const bodyId = `side-${id}`;
  return (
    <div className={`card side-card${open ? '' : ' folded'}${className ? ` ${className}` : ''}`}>
      <div className="card-head">
        <h2>
          <button type="button" className="side-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
            <span className="chev" aria-hidden>
              ▾
            </span>
            <span className="side-title">{title}</span>
          </button>
        </h2>
        {aside}
      </div>
      <div id={bodyId} className="side-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
