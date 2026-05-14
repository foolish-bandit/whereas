import { Link } from "react-router-dom";

import { DEMO_HOME } from "../lib/routes";

export default function DevUserBanner() {
  return (
    <div className="border-b border-warning-ring bg-warning-soft px-4 py-2.5 text-sm text-warning sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0">
          Finish workspace setup to connect this browser to the local API.
        </p>
        <Link
          to={DEMO_HOME}
          className="shrink-0 rounded border border-warning-ring bg-canvas px-2.5 py-1 text-xs font-medium text-warning hover:border-warning"
        >
          Finish setup
        </Link>
      </div>
    </div>
  );
}
