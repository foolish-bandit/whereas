import { Link } from "react-router-dom";

const GITHUB_URL = "https://github.com/foolish-bandit/whereas";
const LICENSE_URL = "https://github.com/foolish-bandit/whereas/blob/main/LICENSE";
const SECURITY_URL =
  "https://github.com/foolish-bandit/whereas/blob/main/SECURITY.md";
const DESIGN_PRINCIPLES_URL =
  "https://github.com/foolish-bandit/whereas/blob/main/docs/design-principles.md";
const README_URL = "https://github.com/foolish-bandit/whereas/blob/main/README.md";

interface FooterLink {
  label: string;
  href?: string;
  to?: string;
  external?: boolean;
}

const COLUMNS: Array<{ heading: string; links: FooterLink[] }> = [
  {
    heading: "Product",
    links: [
      { label: "Demo", to: "/demo" },
      { label: "README", href: README_URL, external: true },
      { label: "Design principles", href: DESIGN_PRINCIPLES_URL, external: true },
    ],
  },
  {
    heading: "Source",
    links: [
      { label: "GitHub", href: GITHUB_URL, external: true },
      { label: "License (AGPL-3.0)", href: LICENSE_URL, external: true },
      { label: "Security", href: SECURITY_URL, external: true },
    ],
  },
];

export default function MarketingFooter() {
  return (
    <footer className="border-t border-rule bg-canvas">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12 lg:px-10">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
          <div>
            <span className="font-serif text-lg tracking-tight text-ink">
              Whereas
            </span>
            <p className="mt-2 max-w-md text-sm text-ink-muted">
              Open-source, self-hostable contract repository. Whereas surfaces
              information about contracts; it does not provide legal advice
              and does not replace human legal review.
            </p>
            <p className="mt-3 text-xs text-ink-subtle">
              Pre-v0.1 · AGPL-3.0-or-later
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
                {col.heading}
              </h3>
              <ul className="mt-3 space-y-2 text-sm">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <FooterLinkRow link={link} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 border-t border-rule pt-6 text-xs text-ink-subtle">
          <p>
            Extracted metadata, clause segmentation, and any AI-driven output
            shown here or in the demo are machine-generated and must be
            reviewed before being relied upon.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterLinkRow({ link }: { link: FooterLink }) {
  const className = "text-ink-muted hover:text-ink";
  if (link.to) {
    return (
      <Link to={link.to} className={className}>
        {link.label}
      </Link>
    );
  }
  if (link.href) {
    const rel = link.external ? "noreferrer noopener" : undefined;
    const target = link.external ? "_blank" : undefined;
    return (
      <a href={link.href} className={className} target={target} rel={rel}>
        {link.label}
      </a>
    );
  }
  return null;
}
