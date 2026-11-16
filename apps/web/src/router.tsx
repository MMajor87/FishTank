import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export type Route = { name: 'home' } | { name: 'account' } | { name: 'admin' } | { name: 'tank'; id: string } | { name: 'join'; code: string } | { name: 'notFound' };

export function matchRoute(path: string): Route {
  if (path === '/' || path === '') return { name: 'home' };
  if (path === '/account' || path === '/account/') return { name: 'account' };
  if (path === '/admin' || path === '/admin/') return { name: 'admin' };
  let m = path.match(new RegExp(`^/t/(${UUID})/?$`));
  if (m) return { name: 'tank', id: m[1]! };
  m = path.match(/^\/join\/([A-Za-z0-9-]{4,64})\/?$/);
  if (m) return { name: 'join', code: decodeURIComponent(m[1]!) };
  return { name: 'notFound' };
}
