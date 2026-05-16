/**
 * Drift alert email template.
 *
 * Pure React component plus a `renderDriftAlertEmail` helper that yields
 * inline-styled HTML safe for any email client. Stays small and dependency-free
 * — no React Email package needed; we render via `renderToStaticMarkup` from
 * react-dom/server.
 *
 * The first version only RENDERS; the cron handler currently logs the rendered HTML
 * for the deployer's email service to forward. Wiring an actual sender
 * (Resend, SES, SendGrid) is deferred — real delivery requires a domain +
 * sender reputation, which is a deployment concern rather than an architectural one.
 *
 * Inline styles (not <style> blocks) so Gmail/Outlook renderers don't strip
 * them. No external assets — every byte arrives in the email body.
 */
import { renderToStaticMarkup } from "react-dom/server";

export interface DriftAlertEmailProps {
  shopName: string;
  shopDomain: string;
  /** ISO date string of the regression run. Rendered as YYYY-MM-DD. */
  generatedAt: string;
  alerts: ReadonlyArray<{
    fixtureSignature: string;
    severity: "critical" | "warning";
    previousSeverity: "critical" | "warning" | "info" | "none";
    summary: string;
  }>;
  /** Absolute URL to the regression dashboard. */
  dashboardUrl: string;
  /** Counts pulled from the regression run for the headline. */
  stats: {
    fixturesExamined: number;
    newCritical: number;
    newWarning: number;
  };
}

const COLORS = Object.freeze({
  background: "#f6f6f7",
  card: "#ffffff",
  border: "#e1e3e5",
  text: "#202223",
  textSubdued: "#6d7175",
  critical: "#d72c0d",
  warning: "#b98900",
  info: "#1f5199",
  link: "#005bd3",
});

function severityColor(s: "critical" | "warning" | "info" | "none"): string {
  if (s === "critical") return COLORS.critical;
  if (s === "warning") return COLORS.warning;
  if (s === "info") return COLORS.info;
  return COLORS.textSubdued;
}

function severityLabel(s: "critical" | "warning" | "info" | "none"): string {
  if (s === "critical") return "Critical";
  if (s === "warning") return "Warning";
  if (s === "info") return "Info";
  return "Unchanged";
}

export function DriftAlertEmail(props: DriftAlertEmailProps) {
  const { shopName, shopDomain, generatedAt, alerts, dashboardUrl, stats } = props;
  const date = generatedAt.slice(0, 10);
  const headline =
    stats.newCritical > 0
      ? `${stats.newCritical} new critical drift${stats.newCritical === 1 ? "" : "s"} detected`
      : `${stats.newWarning} new warning drift${stats.newWarning === 1 ? "" : "s"} detected`;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Script Sentinel drift alert — {shopName}</title>
      </head>
      <body
        style={{
          margin: 0,
          padding: "24px",
          backgroundColor: COLORS.background,
          color: COLORS.text,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          fontSize: "14px",
          lineHeight: "1.4",
        }}
      >
        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          style={{ maxWidth: "600px", margin: "0 auto" }}
        >
          <tr>
            <td
              style={{
                backgroundColor: COLORS.card,
                border: `1px solid ${COLORS.border}`,
                borderRadius: "8px",
                padding: "24px",
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: COLORS.textSubdued,
                  fontSize: "12px",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Script Sentinel · {date}
              </p>
              <h1
                style={{
                  margin: "8px 0 4px",
                  fontSize: "20px",
                  color: COLORS.critical,
                }}
              >
                {headline}
              </h1>
              <p style={{ margin: "0 0 16px", color: COLORS.textSubdued }}>
                {shopName} ({shopDomain}) — {stats.fixturesExamined} fixture
                {stats.fixturesExamined === 1 ? "" : "s"} examined.
              </p>

              {alerts.length === 0 ? null : (
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{
                    borderCollapse: "collapse",
                    margin: "16px 0",
                  }}
                >
                  {alerts.map((a) => (
                    <tr key={a.fixtureSignature}>
                      <td
                        style={{
                          borderTop: `1px solid ${COLORS.border}`,
                          padding: "12px 0",
                          verticalAlign: "top",
                        }}
                      >
                        <p
                          style={{
                            margin: 0,
                            fontWeight: 600,
                            color: severityColor(a.severity),
                          }}
                        >
                          {severityLabel(a.severity)} ·{" "}
                          <span style={{ color: COLORS.textSubdued }}>
                            (was {severityLabel(a.previousSeverity)})
                          </span>
                        </p>
                        <p style={{ margin: "4px 0 0" }}>{a.summary}</p>
                        <p
                          style={{
                            margin: "4px 0 0",
                            color: COLORS.textSubdued,
                            fontSize: "12px",
                            fontFamily: "monospace",
                          }}
                        >
                          fixture {a.fixtureSignature.slice(0, 12)}…
                        </p>
                      </td>
                    </tr>
                  ))}
                </table>
              )}

              <p style={{ margin: "20px 0 0" }}>
                <a
                  href={dashboardUrl}
                  style={{
                    color: COLORS.link,
                    textDecoration: "none",
                    fontWeight: 600,
                  }}
                >
                  Open the regression dashboard →
                </a>
              </p>
              <p
                style={{
                  margin: "20px 0 0",
                  color: COLORS.textSubdued,
                  fontSize: "12px",
                }}
              >
                You're receiving this because you subscribed to the Script
                Sentinel Regression Suite. Drift alerts are sent only when a
                fixture's severity escalates compared to the previous run.
              </p>
            </td>
          </tr>
        </table>
      </body>
    </html>
  );
}

export function renderDriftAlertEmail(props: DriftAlertEmailProps): string {
  return `<!DOCTYPE html>${renderToStaticMarkup(<DriftAlertEmail {...props} />)}`;
}
