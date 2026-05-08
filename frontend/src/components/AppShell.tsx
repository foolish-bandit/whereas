import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import DemoModeBanner from "./DemoModeBanner";
import Header from "./Header";
import Sidebar from "./Sidebar";
import DevUserBanner from "./DevUserBanner";
import { getDevUserId } from "../lib/devUser";
import { isDemoMode } from "../lib/env";

export default function AppShell({ children }: { children: ReactNode }) {
  const demo = isDemoMode();
  const [devUserId, setDevUserIdState] = useState<string | null>(() =>
    getDevUserId(),
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "whereas.devUserId" || e.key === null) {
        setDevUserIdState(getDevUserId());
      }
    }
    function onCustom() {
      setDevUserIdState(getDevUserId());
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("whereas:devUserChanged", onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("whereas:devUserChanged", onCustom);
    };
  }, []);

  // Auto-close the mobile drawer whenever the route changes so users
  // don't get stuck on the previous page's overlay after tapping a
  // nav link.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-full min-h-screen bg-canvas-subtle">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          devUserId={devUserId}
          demoMode={demo}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
        {demo && <DemoModeBanner />}
        {!demo && !devUserId && <DevUserBanner />}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
