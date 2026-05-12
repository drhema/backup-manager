import type { FC } from "hono/jsx";

export const Layout: FC<{ title?: string; active?: string; children?: any }> = ({
  title = "Backup Manager",
  active = "dashboard",
  children,
}) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://unpkg.com/htmx.org@2.0.3"></script>
      <style>{`
        body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .htmx-indicator { display: none; }
        .htmx-request .htmx-indicator { display: inline; }
        .htmx-request.htmx-indicator { display: inline; }
      `}</style>
    </head>
    <body class="bg-slate-50 text-slate-900 min-h-screen">
      <nav class="bg-slate-900 text-slate-100">
        <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div class="flex items-center gap-6">
            <a href="/" class="font-semibold tracking-tight">Backup Manager</a>
            <NavLink href="/" label="Dashboard" active={active === "dashboard"} />
            <NavLink href="/databases" label="Databases" active={active === "databases"} />
            <NavLink href="/destinations" label="Destinations" active={active === "destinations"} />
            <NavLink href="/backups" label="Backups" active={active === "backups"} />
            <NavLink href="/schedules" label="Schedules" active={active === "schedules"} />
            <NavLink href="/s3-browser" label="S3 Browser" active={active === "s3-browser"} />
          </div>
          <a href="/healthz" class="text-xs text-slate-400 hover:text-slate-100">health</a>
        </div>
      </nav>
      <main class="max-w-7xl mx-auto px-4 py-6">{children}</main>
    </body>
  </html>
);

const NavLink: FC<{ href: string; label: string; active: boolean }> = ({
  href,
  label,
  active,
}) => (
  <a
    href={href}
    class={`text-sm ${active ? "text-white border-b border-white" : "text-slate-300 hover:text-white"}`}
  >
    {label}
  </a>
);

export const Card: FC<{ title?: string; children?: any; actions?: any }> = ({
  title,
  children,
  actions,
}) => (
  <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
    {title && (
      <header class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
        <h2 class="text-sm font-semibold tracking-tight text-slate-700">{title}</h2>
        {actions && <div class="flex items-center gap-2">{actions}</div>}
      </header>
    )}
    <div class="p-4">{children}</div>
  </section>
);

export const Btn: FC<{
  href?: string;
  children?: any;
  variant?: "primary" | "secondary" | "danger";
  hx?: Record<string, string>;
  type?: "submit" | "button";
}> = ({ href, children, variant = "secondary", hx, type }) => {
  const cls = {
    primary: "bg-slate-900 text-white hover:bg-slate-800",
    secondary: "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50",
    danger: "bg-red-600 text-white hover:bg-red-500",
  }[variant];
  const klass = `inline-flex items-center gap-1 text-sm rounded px-3 py-1.5 ${cls}`;
  if (href) {
    return (
      <a href={href} class={klass}>
        {children}
      </a>
    );
  }
  const props: Record<string, any> = { class: klass, type: type ?? "button" };
  if (hx) {
    for (const [k, v] of Object.entries(hx)) props[k] = v;
  }
  return <button {...props}>{children}</button>;
};

export const Badge: FC<{ tone: "success" | "danger" | "info" | "neutral"; children?: any }> = ({
  tone,
  children,
}) => {
  const cls = {
    success: "bg-emerald-100 text-emerald-800",
    danger: "bg-red-100 text-red-800",
    info: "bg-sky-100 text-sky-800",
    neutral: "bg-slate-100 text-slate-700",
  }[tone];
  return (
    <span class={`inline-block text-xs px-2 py-0.5 rounded-full ${cls}`}>{children}</span>
  );
};

export function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
