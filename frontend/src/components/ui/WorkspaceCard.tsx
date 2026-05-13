import { Link } from "react-router-dom";

interface WorkspaceCardBaseProps {
  title: string;
  description?: string;
  /**
   * "primary" — white background, subtle on hover (default).
   * "default" — subtle background, white on hover.
   * "warning" — warning-tinted background.
   */
  variant?: "primary" | "default" | "warning";
  testId?: string;
}

interface WorkspaceCardLinkProps extends WorkspaceCardBaseProps {
  /** React Router destination. Use for in-app navigation. */
  to: string;
  href?: never;
  onClick?: never;
}

interface WorkspaceCardAnchorProps extends WorkspaceCardBaseProps {
  /** Plain anchor href (e.g. same-page `#section` jumps). */
  href: string;
  to?: never;
  onClick?: never;
}

interface WorkspaceCardButtonProps extends WorkspaceCardBaseProps {
  onClick: () => void;
  to?: never;
  href?: never;
}

type WorkspaceCardProps =
  | WorkspaceCardLinkProps
  | WorkspaceCardAnchorProps
  | WorkspaceCardButtonProps;

const VARIANT_CLASSES: Record<
  NonNullable<WorkspaceCardBaseProps["variant"]>,
  string
> = {
  primary:
    "border-rule bg-canvas hover:border-rule-strong hover:bg-canvas-subtle",
  default:
    "border-rule bg-canvas-subtle hover:border-rule-strong hover:bg-canvas",
  warning:
    "border-warning-ring bg-warning-soft hover:border-warning",
};

function CardBody({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && (
        <p className="mt-1 text-xs text-ink-muted">{description}</p>
      )}
    </>
  );
}

export default function WorkspaceCard(props: WorkspaceCardProps) {
  const { title, description, variant = "primary", testId } = props;
  const variantCls = VARIANT_CLASSES[variant];
  const baseCls = `group rounded border p-3 transition-colors ${variantCls}`;

  if ("to" in props && props.to !== undefined) {
    return (
      <Link to={props.to} data-testid={testId} className={baseCls}>
        <CardBody title={title} description={description} />
      </Link>
    );
  }

  if ("href" in props && props.href !== undefined) {
    return (
      <a href={props.href} data-testid={testId} className={baseCls}>
        <CardBody title={title} description={description} />
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={(props as WorkspaceCardButtonProps).onClick}
      data-testid={testId}
      className={`w-full text-left ${baseCls}`}
    >
      <CardBody title={title} description={description} />
    </button>
  );
}
