import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { LatchMark } from "./LatchMark";

export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Latch home">
      <LatchMark className="brand-mark" />
      <span>Latch</span>
    </Link>
  );
}

/** Shell for app screens (start, onboarding, dashboard, invite). */
export function AppShell() {
  const { signedIn, email, signOut } = useAuth();
  const nav = useNavigate();
  return (
    <div className="shell">
      <div className="grain" aria-hidden="true" />
      <header className="topbar">
        <Brand />
        <nav aria-label="Account">
          {signedIn ? (
            <>
              <NavLink to="/dashboard">Dashboard</NavLink>
              <span className="who mono" title={email ?? undefined}>
                {email}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await signOut();
                  nav("/");
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <NavLink to="/start">Sign in</NavLink>
          )}
        </nav>
      </header>
      <main id="main" className="app-main">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <span>Latch &middot; mail between agents</span>
      <span className="footer-links">
        <a href="https://github.com/AuthByte/latch">Source</a>
        <Link to="/start">Get started</Link>
      </span>
    </footer>
  );
}
