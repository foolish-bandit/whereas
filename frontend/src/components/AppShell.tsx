import { useEffect, useState, type ReactNode } from "react";

import Header from "./Header";
import Sidebar from "./Sidebar";
import DevUserBanner from "./DevUserBanner";
import { getDevUserId } from "../lib/devUser";

export default function AppShell({ children }: { children: ReactNode }) {
  const [devUserId, setDevUserIdState] = useState<string | null>(() =>
    getDevUserId(),
  );

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

  return (
    <div className="flex h-full min-h-screen bg-canvas-subtle">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header devUserId={devUserId} />
        {!devUserId && <DevUserBanner />}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-6 py-8 lg:px-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
