import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { authErrorFromUrl } from "./returnPath";
import { MeProvider } from "./me";
import { AppShell } from "./components/Layout";
import { PageLoading } from "./components/ui";
import { Landing } from "./pages/Landing";
import { Start } from "./pages/Start";
import { Onboarding } from "./pages/Onboarding";
import { Dashboard } from "./pages/Dashboard";
import { Invite } from "./pages/Invite";
import { NotFound } from "./pages/NotFound";

function RequireAuth() {
  const { status, signedIn } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <PageLoading label="Signing you in" />;
  if (!signedIn) return <Navigate to="/start" replace state={{ from: loc.pathname + loc.search, authError: authErrorFromUrl() ?? undefined }} />;
  return (
    <MeProvider>
      <Outlet />
    </MeProvider>
  );
}

export function App() {
  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route element={<AppShell />}>
          <Route path="/start" element={<Start />} />
          <Route path="/i/:token" element={<Invite />} />
          <Route element={<RequireAuth />}>
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/dashboard" element={<Dashboard />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}
