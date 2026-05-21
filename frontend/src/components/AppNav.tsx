import { Link, useLocation } from 'react-router-dom';

interface AppNavProps {
  /** When set, surfaces the org-scoped links (Cases / Review queue / Config). */
  orgId?: string;
}

/**
 * Persistent top nav. Drops into every page so the handler can jump
 * between cases and the review queue without going via the org list.
 *
 * If `orgId` is omitted (org-list landing, login), only the home link
 * is shown.
 */
export function AppNav({ orgId }: AppNavProps): JSX.Element {
  const { pathname } = useLocation();
  return (
    <nav className="border-b border-border bg-muted/30">
      <div className="px-6 py-2 flex items-center gap-4 text-sm">
        <Link
          to="/"
          className={`font-semibold ${pathname === '/' ? '' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Arrears
        </Link>
        {orgId && (
          <>
            <span className="text-muted-foreground">›</span>
            <NavLink
              to={`/organisations/${encodeURIComponent(orgId)}/cases`}
              currentPath={pathname}
            >
              Cases
            </NavLink>
            <NavLink
              to={`/organisations/${encodeURIComponent(orgId)}/review-queue`}
              currentPath={pathname}
            >
              Review queue
            </NavLink>
            <NavLink
              to={`/organisations/${encodeURIComponent(orgId)}/config`}
              currentPath={pathname}
            >
              Config
            </NavLink>
            <span className="ml-auto text-xs text-muted-foreground font-mono">
              org: {orgId}
            </span>
          </>
        )}
      </div>
    </nav>
  );
}

function NavLink({
  to,
  currentPath,
  children,
}: {
  to: string;
  currentPath: string;
  children: React.ReactNode;
}): JSX.Element {
  const active = currentPath === to || currentPath.startsWith(to);
  return (
    <Link
      to={to}
      className={
        active
          ? 'text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground'
      }
    >
      {children}
    </Link>
  );
}
