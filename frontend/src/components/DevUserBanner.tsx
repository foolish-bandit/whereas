import { Link } from "react-router-dom";

export default function DevUserBanner() {
  return (
    <div className="border-b border-warning-ring bg-warning-soft px-6 py-2.5 text-sm text-warning">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
        <p>Set a development user ID to call the local API.</p>
        <Link
          to="/settings"
          className="shrink-0 rounded border border-warning-ring bg-canvas px-2.5 py-1 text-xs font-medium text-warning hover:border-warning"
        >
          Open settings
        </Link>
      </div>
    </div>
  );
}
