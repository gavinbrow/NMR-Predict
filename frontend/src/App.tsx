import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type JSX } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "./pages/Home.tsx";
import Index from "./pages/Index.tsx";
import Kinetics from "./pages/Kinetics.tsx";
import NotFound from "./pages/NotFound.tsx";
import SpectrumAnalysis from "./pages/SpectrumAnalysis.tsx";

const queryClient = new QueryClient();

// Workspaces whose progress we want to preserve across tab switches. Each is
// lazy-mounted on first visit, then kept in the React tree (just hidden via
// `display: none`) so all of its component-level state survives navigation:
// Index's Ketcher draft + prediction components, Kinetics' tracked peaks /
// timepoints, and — crucially — NMRium's internally-held loaded spectra,
// baselines, and integrations, which would otherwise be lost on unmount.
const KEEP_ALIVE: { path: string; element: JSX.Element }[] = [
  { path: "/analysis", element: <SpectrumAnalysis /> },
  { path: "/prediction", element: <Index /> },
  { path: "/kinetics", element: <Kinetics /> },
];
const KEEP_ALIVE_PATHS = new Set(KEEP_ALIVE.map((route) => route.path));

const AppRoutes = () => {
  const location = useLocation();
  const isKeepAlive = KEEP_ALIVE_PATHS.has(location.pathname);

  // Track which keep-alive paths the user has visited at least once. We only
  // pay each workspace's mount cost (NMRium, prediction backend boot, …) when
  // it's actually opened — after that it stays in the tree.
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!isKeepAlive) return;
    setVisited((prev) => {
      if (prev.has(location.pathname)) return prev;
      const next = new Set(prev);
      next.add(location.pathname);
      return next;
    });
  }, [isKeepAlive, location.pathname]);

  return (
    <>
      {KEEP_ALIVE.map(({ path, element }) =>
        visited.has(path) ? (
          <div
            key={path}
            // `display: contents` keeps the wrapper invisible to layout when
            // active (the page's own AppShell governs the page chrome), and
            // `display: none` hides it without unmounting when inactive.
            style={{ display: location.pathname === path ? "contents" : "none" }}
          >
            {element}
          </div>
        ) : null,
      )}

      {/* Stateless routes still go through React Router normally. */}
      {!isKeepAlive ? (
        <Routes>
          <Route path="/" element={<Home />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      ) : null}
    </>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
