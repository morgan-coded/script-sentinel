/**
 * Migration Risk Audit — React-PDF deliverable.
 *
 * Renders the structured `AuditSnapshot` from `app/lib/audit/risk-scorer.ts`
 * into a multi-page PDF using `@react-pdf/renderer`. The PDF is server-side
 * rendered on demand from the persisted snapshot — see the audit README for
 * the "data is the source of truth, PDF is a view" rationale.
 *
 * Visual design choices kept simple on purpose:
 *   - One typeface (Helvetica) so we don't ship font assets in the bundle.
 *   - Two-column risk-table layout sized for A4 / Letter.
 *   - Risk grades are colour-coded but always also labelled — the deliverable
 *     must be readable when printed in greyscale.
 */

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import type { AuditSnapshot, RiskGrade } from "../audit/risk-scorer";
import type { DriftSeverity } from "../audit/diff-engine";

const palette = {
  ink: "#0F172A",
  muted: "#475569",
  faint: "#CBD5E1",
  paper: "#FFFFFF",
  accent: "#0F4C81",
  high: "#B91C1C",
  medium: "#B45309",
  low: "#15803D",
  unknown: "#64748B",
};

const styles = StyleSheet.create({
  page: {
    padding: 48,
    fontFamily: "Helvetica",
    color: palette.ink,
    fontSize: 10,
    backgroundColor: palette.paper,
  },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: palette.faint,
    paddingBottom: 12,
    marginBottom: 18,
  },
  brand: {
    fontSize: 9,
    color: palette.accent,
    marginBottom: 4,
    letterSpacing: 1,
  },
  title: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    color: palette.muted,
  },
  section: {
    marginBottom: 16,
  },
  sectionHeading: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
    color: palette.accent,
  },
  paragraph: {
    fontSize: 10,
    lineHeight: 1.5,
    marginBottom: 6,
    color: palette.ink,
  },
  mutedSmall: {
    fontSize: 9,
    color: palette.muted,
  },
  countsRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  countBox: {
    flex: 1,
    padding: 8,
    borderWidth: 1,
    borderColor: palette.faint,
    borderRadius: 3,
    marginRight: 6,
  },
  countLabel: {
    fontSize: 8,
    color: palette.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  countValue: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    marginTop: 2,
  },
  card: {
    borderWidth: 1,
    borderColor: palette.faint,
    borderRadius: 3,
    padding: 10,
    marginBottom: 8,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  cardTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 2,
    fontSize: 8,
    color: palette.paper,
    fontFamily: "Helvetica-Bold",
  },
  bullet: {
    flexDirection: "row",
    marginBottom: 2,
    paddingLeft: 4,
  },
  bulletDot: {
    fontSize: 10,
    marginRight: 6,
  },
  bulletText: {
    flex: 1,
    fontSize: 9.5,
    lineHeight: 1.4,
  },
  checklistRow: {
    flexDirection: "row",
    marginBottom: 6,
  },
  checklistRank: {
    width: 22,
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: palette.accent,
  },
  checklistContent: {
    flex: 1,
  },
  checklistTitle: {
    fontSize: 10,
    marginBottom: 2,
    fontFamily: "Helvetica-Bold",
  },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 48,
    right: 48,
    fontSize: 8,
    color: palette.muted,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: palette.faint,
    paddingTop: 6,
  },
});

function gradeColor(grade: RiskGrade): string {
  return palette[grade];
}

function gradeLabel(grade: RiskGrade): string {
  switch (grade) {
    case "high":
      return "HIGH";
    case "medium":
      return "MEDIUM";
    case "low":
      return "LOW";
    case "unknown":
      return "REVIEW";
  }
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function Badge({ grade }: { grade: RiskGrade }) {
  return (
    <Text style={[styles.badge, { backgroundColor: gradeColor(grade) }]}>
      {gradeLabel(grade)}
    </Text>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

function Header({ snapshot }: { snapshot: AuditSnapshot }) {
  const scopeLabel =
    snapshot.scope === "single" ? "Single Script Family" : "All Script Families";
  return (
    <View style={styles.header} fixed>
      <Text style={styles.brand}>SCRIPT SENTINEL · MIGRATION RISK AUDIT</Text>
      <Text style={styles.title}>{snapshot.shopName}</Text>
      <Text style={styles.subtitle}>
        {snapshot.shopDomain}
        {snapshot.planDisplayName ? ` · ${snapshot.planDisplayName}` : ""} · {scopeLabel} · Generated{" "}
        {fmtDate(snapshot.generatedAt)}
      </Text>
    </View>
  );
}

function ExecutiveSummary({ snapshot }: { snapshot: AuditSnapshot }) {
  // Honest one-line risk profile — counts only, no fabricated 0–100 score.
  const profileLine = `${snapshot.counts.highRisk} high-risk · ${snapshot.counts.mediumRisk} medium · ${snapshot.counts.lowRisk} low · ${snapshot.counts.unknownRisk} needs review`;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Executive summary</Text>
      <Text style={styles.paragraph}>
        Risk profile across your inventoried Scripts: <Text style={{ fontFamily: "Helvetica-Bold" }}>{profileLine}</Text>. Work the migration checklist top-down — the first item is the highest-impact regression risk.
      </Text>
      <View style={styles.countsRow}>
        <View style={styles.countBox}>
          <Text style={styles.countLabel}>Scripts audited</Text>
          <Text style={styles.countValue}>{snapshot.counts.scripts}</Text>
          <Text style={styles.mutedSmall}>{snapshot.counts.activeScripts} active</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={styles.countLabel}>Cart fixtures</Text>
          <Text style={styles.countValue}>{snapshot.counts.fixtures}</Text>
          <Text style={styles.mutedSmall}>from order history</Text>
        </View>
        <View style={styles.countBox}>
          <Text style={styles.countLabel}>High-risk</Text>
          <Text style={[styles.countValue, { color: palette.high }]}>{snapshot.counts.highRisk}</Text>
          <Text style={styles.mutedSmall}>needs migration scrutiny</Text>
        </View>
      </View>
      {snapshot.topRisks.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <Text style={[styles.paragraph, { fontFamily: "Helvetica-Bold" }]}>Top risks to address first</Text>
          {snapshot.topRisks.map((risk) => (
            <View key={risk.scriptId} style={styles.bullet}>
              <Badge grade={risk.grade} />
              <Text style={[styles.bulletText, { marginLeft: 6 }]}>
                <Text style={{ fontFamily: "Helvetica-Bold" }}>{risk.title}</Text>
                {" — "}
                {risk.reason}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.paragraph}>
          No high-risk scripts detected. Verify low-risk discount logic against the cart fixtures
          before cutting over.
        </Text>
      )}
    </View>
  );
}

function PerScriptSection({ snapshot }: { snapshot: AuditSnapshot }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Per-script breakdown</Text>
      {snapshot.scripts.length === 0 ? (
        <Text style={styles.paragraph}>
          No scripts inventoried for this shop. Paste your Shopify Script source on the Scripts page
          before re-running this audit.
        </Text>
      ) : (
        snapshot.scripts.map((script) => (
          <View key={script.id} style={styles.card} wrap={false}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{script.title}</Text>
              <Badge grade={script.riskGrade} />
            </View>
            <Text style={styles.mutedSmall}>{script.summary}</Text>
            {script.riskReasons.map((reason, i) => (
              <Bullet key={i}>{reason}</Bullet>
            ))}
            {script.edgeCases.length > 0 ? (
              <View style={{ marginTop: 4 }}>
                <Text style={styles.mutedSmall}>Edge cases observed in your last 60 days:</Text>
                {script.edgeCases.map((edge, i) => (
                  <Bullet key={i}>{edge}</Bullet>
                ))}
              </View>
            ) : null}
          </View>
        ))
      )}
    </View>
  );
}

function FixturesSection({ snapshot }: { snapshot: AuditSnapshot }) {
  if (snapshot.fixtures.length === 0) return null;
  // Cap the fixture table at the 25 most-observed fixtures so the PDF doesn't
  // balloon for high-volume stores. The full set lives in the database.
  const visible = snapshot.fixtures.slice(0, 25);
  return (
    <View style={styles.section} break>
      <Text style={styles.sectionHeading}>Fixture-by-fixture risk table</Text>
      <Text style={styles.mutedSmall}>
        Showing the top {visible.length} of {snapshot.fixtures.length} cart fixtures.
        Each row's baseline came from real historical orders — your new Function should reproduce
        the same outcome on the same cart inputs.
      </Text>
      {visible.map((fixture) => (
        <View key={fixture.id} style={styles.card} wrap={false}>
          <Text style={styles.cardTitle}>{fixture.summary}</Text>
          {fixture.baselineNotes.map((note, i) => (
            <Text key={i} style={styles.mutedSmall}>
              {note}
            </Text>
          ))}
          {fixture.migrationRisks.length > 0 ? (
            <View style={{ marginTop: 4 }}>
              {fixture.migrationRisks.map((risk, i) => (
                <Bullet key={i}>{risk}</Bullet>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function ChecklistSection({ snapshot }: { snapshot: AuditSnapshot }) {
  return (
    <View style={styles.section} break>
      <Text style={styles.sectionHeading}>Migration checklist</Text>
      <Text style={styles.mutedSmall}>
        Ranked by risk grade and complexity. Work top-down — the first item is the highest-impact
        regression risk.
      </Text>
      {snapshot.checklist.length === 0 ? (
        <Text style={styles.paragraph}>No checklist items — no scripts to migrate.</Text>
      ) : (
        snapshot.checklist.map((item) => (
          <View key={item.rank} style={styles.checklistRow} wrap={false}>
            <Text style={styles.checklistRank}>{item.rank}.</Text>
            <View style={styles.checklistContent}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={styles.checklistTitle}>{item.title}</Text>
                <Badge grade={item.riskGrade} />
              </View>
              <Text style={styles.mutedSmall}>{item.detail}</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function DriftSeverityBadge({ severity }: { severity: DriftSeverity }) {
  const color =
    severity === "critical"
      ? palette.high
      : severity === "warning"
        ? palette.medium
        : palette.unknown;
  return (
    <Text style={[styles.badge, { backgroundColor: color }]}>
      {severity.toUpperCase()}
    </Text>
  );
}

function DriftAlertsSection({ snapshot }: { snapshot: AuditSnapshot }) {
  // Drift insertion point. Sits between fixtures and checklist so
  // the merchant sees "what diverged in production" before "what to do about
  // it." When drift wasn't run for this audit (legacy snapshot or no
  // Function deployments yet), render a brief explainer instead of nothing.
  const drift = snapshot.drift;
  if (!drift) {
    return (
      <View style={styles.section} break>
        <Text style={styles.sectionHeading}>Drift alerts</Text>
        <Text style={styles.paragraph}>
          No drift run is attached to this audit. Run the diff engine from the
          Drift page to compare your fixture baselines against captured
          Function-era outputs.
        </Text>
      </View>
    );
  }

  const summaryLine = `${drift.examined} fixtures examined · ${drift.matched} match · ${drift.drift} drift (${drift.critical} critical, ${drift.warning} warning, ${drift.info} info) · ${drift.missing} untested in production`;

  return (
    <View style={styles.section} break>
      <Text style={styles.sectionHeading}>Drift alerts</Text>
      <Text style={styles.mutedSmall}>{summaryLine}</Text>
      {drift.alerts.length === 0 ? (
        <Text style={styles.paragraph}>
          {drift.examined === 0
            ? "No fixtures available to diff yet. Generate cart fixtures and capture Function outputs first."
            : "Every captured Function output matches its Script-era baseline. No drift detected."}
        </Text>
      ) : (
        drift.alerts.map((alert) => (
          <View key={alert.fixtureSignature} style={styles.card} wrap={false}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>
                Fixture {alert.fixtureSignature.slice(0, 12)}…
              </Text>
              <DriftSeverityBadge severity={alert.severity} />
            </View>
            <Text style={styles.mutedSmall}>
              Categories: {alert.categories.join(", ")}
            </Text>
            <Bullet>{alert.message}</Bullet>
            <Bullet>{alert.recommendation}</Bullet>
            <Text style={styles.mutedSmall}>
              Baseline: discount{" "}
              {alert.baseline.totalDiscount.toFixed(2)}{" "}
              {alert.baseline.presentmentCurrency}
              {alert.baseline.shippingCode
                ? ` · ${alert.baseline.shippingCode} ${(alert.baseline.shippingAmount ?? 0).toFixed(2)}`
                : ""}
              {alert.baseline.paymentGateways.length > 0
                ? ` · ${alert.baseline.paymentGateways.join("/")}`
                : ""}
            </Text>
            <Text style={styles.mutedSmall}>
              Function output: discount{" "}
              {alert.output.totalDiscount.toFixed(2)}{" "}
              {alert.output.presentmentCurrency}
              {alert.output.shippingCode
                ? ` · ${alert.output.shippingCode} ${(alert.output.shippingAmount ?? 0).toFixed(2)}`
                : ""}
              {alert.output.paymentGateways.length > 0
                ? ` · ${alert.output.paymentGateways.join("/")}`
                : ""}
            </Text>
          </View>
        ))
      )}
      {drift.missingSignatures.length > 0 ? (
        <Text style={styles.mutedSmall}>
          {drift.missingSignatures.length} fixture
          {drift.missingSignatures.length === 1 ? "" : "s"} have no captured
          Function output yet — untested in production. See the Functions
          page to capture more orders, or generate a synthetic order before
          cutover.
        </Text>
      ) : null}
    </View>
  );
}

function OpenQuestionsSection({ snapshot }: { snapshot: AuditSnapshot }) {
  if (snapshot.openQuestions.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Open questions for the merchant or developer</Text>
      <Text style={styles.mutedSmall}>
        We flagged these because the heuristic auditor couldn't answer them confidently. Resolving
        each question before migration cutover is the cheapest way to avoid a BFCM regression.
      </Text>
      {snapshot.openQuestions.map((q) => (
        <Bullet key={q.id}>{q.question}</Bullet>
      ))}
    </View>
  );
}

function Footer({ snapshot }: { snapshot: AuditSnapshot }) {
  return (
    <View style={styles.footer} fixed>
      <Text>
        Generated by Script Sentinel · {snapshot.shopDomain} · {fmtDate(snapshot.generatedAt)} · valid for re-download for 12 months
      </Text>
      <Text
        render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
      />
    </View>
  );
}

export interface AuditReportDocumentProps {
  snapshot: AuditSnapshot;
}

export function AuditReportDocument({ snapshot }: AuditReportDocumentProps) {
  return (
    <Document
      title={`Migration Risk Audit — ${snapshot.shopName}`}
      author="Script Sentinel"
      subject="Shopify Scripts to Functions migration risk audit"
    >
      <Page size="A4" style={styles.page}>
        <Header snapshot={snapshot} />
        <ExecutiveSummary snapshot={snapshot} />
        <PerScriptSection snapshot={snapshot} />
        <FixturesSection snapshot={snapshot} />
        <DriftAlertsSection snapshot={snapshot} />
        <ChecklistSection snapshot={snapshot} />
        <OpenQuestionsSection snapshot={snapshot} />
        <Footer snapshot={snapshot} />
      </Page>
    </Document>
  );
}
