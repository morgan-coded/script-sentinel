/**
 * Server-only helper: render the React-PDF audit report to a Buffer for
 * streaming as a download response.
 *
 * Kept separate from `audit-report.tsx` so the JSX module stays
 * environment-agnostic and easy to snapshot-test, while the
 * `pdf().toBuffer()` call is fenced off behind the `.server.ts` suffix.
 */

import { renderToBuffer } from "@react-pdf/renderer";
import { AuditReportDocument } from "./audit-report";
import type { AuditSnapshot } from "../audit/risk-scorer";

export async function renderAuditReport(snapshot: AuditSnapshot): Promise<Buffer> {
  return renderToBuffer(<AuditReportDocument snapshot={snapshot} />);
}
