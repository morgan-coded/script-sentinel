import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

const evidenceCards = [
  {
    title: "Migration Risk Audit PDF",
    body: "Export stakeholder-ready evidence with fixture coverage, drift findings, and review notes.",
  },
  {
    title: "PII-scrubbed cart fixtures",
    body: "Use recent order shapes without names, emails, phone numbers, or street addresses.",
  },
  {
    title: "60-day order window",
    body: "Stay honest about standard Shopify order access unless read_all_orders is approved.",
  },
  {
    title: "Regression suite",
    body: "Keep comparing captured Function behavior as teams iterate toward launch.",
  },
];

const workflowSteps = [
  "Paste legacy Ruby Script source",
  "Generate scrubbed cart fixtures",
  "Capture observed Function outputs",
  "Compare drift and untested cases",
  "Export audit evidence",
];

const trustBoundaries = [
  "Read-only Shopify scopes",
  "No discount writes",
  "No Script or Function deployment",
  "No checkout behavior changes",
  "No auto-conversion claims",
  "Plus-only migration focus",
];

export const meta: MetaFunction = () => [
  { title: "Script Sentinel - Shopify Scripts to Functions parity testing" },
  {
    name: "description",
    content:
      "Read-only parity and regression testing for Shopify Plus teams migrating legacy Scripts to Shopify Functions before the June 30, 2026 cutoff.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Script Sentinel home">
          <span className={styles.mark}>S</span>
          <span>
            <strong>Script Sentinel</strong>
            <small>Shopify Plus migration evidence</small>
          </span>
        </a>
        <nav className={styles.nav} aria-label="Page sections">
          <a href="#deadline">Deadline</a>
          <a href="#evidence">Evidence</a>
          <a href="#workflow">Workflow</a>
          <a href="#read-only">Read-only</a>
          <a href="/docs.html">Docs</a>
        </nav>
        <a className={styles.headerCta} href="#open">
          Open app
        </a>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.deadlinePill}>June 30, 2026 cutoff</span>
          <h1>Prove Shopify Functions match legacy Scripts before the cutoff.</h1>
          <p>
            Script Sentinel gives Shopify Plus teams read-only parity and regression evidence
            for Scripts-to-Functions migrations: scrubbed cart fixtures, observed Function output,
            drift review, and audit-ready exports.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryAction} href="#open">
              Open Script Sentinel
            </a>
            <a className={styles.secondaryAction} href="/legal/privacy.html">
              Privacy policy
            </a>
          </div>
        </div>

        <section className={styles.preview} aria-label="Sample parity evidence preview">
          <div className={styles.previewHeader}>
            <div>
              <span>Sample evidence run</span>
              <h2>Scripts-to-Functions parity review</h2>
            </div>
            <strong>Sample data</strong>
          </div>
          <div className={styles.previewGrid}>
            <article className={styles.codeCard}>
              <span>Legacy Script</span>
              <pre>{`if cart.total_price > Money.new(cents: 15000)
  cart.shipping_rates.each { |rate|
    rate.apply_discount(rate.price, message: "Free shipping")
  }
end`}</pre>
            </article>
            <article className={styles.driftCard}>
              <span>Drift comparison</span>
              <ul>
                <li>
                  <strong>Match</strong>
                  Shipping discount parity confirmed
                </li>
                <li>
                  <strong>Needs review</strong>
                  B2B tag branch changed output
                </li>
                <li>
                  <strong>Untested</strong>
                  No captured production output yet
                </li>
              </ul>
            </article>
            <article className={styles.codeCard}>
              <span>Function output</span>
              <pre>{`{
  "discountApplication": "shipping",
  "message": "Free shipping",
  "status": "observed"
}`}</pre>
            </article>
          </div>
        </section>
      </section>

      <section id="deadline" className={styles.deadlineSection}>
        <div>
          <span className={styles.sectionNumber}>01</span>
          <h2>Deadline pressure needs evidence, not guesswork.</h2>
        </div>
        <p>
          Shopify Scripts shut off on June 30, 2026. Script Sentinel helps teams document whether
          migrated Functions behave like the legacy Ruby logic on the same cart shapes, before
          customers discover drift in checkout.
        </p>
      </section>

      <section id="evidence" className={styles.section}>
        <div className={styles.sectionIntro}>
          <span className={styles.sectionNumber}>02</span>
          <h2>Evidence your operator, agency, and developer can use.</h2>
          <p>
            The output is a migration record: what was tested, where parity looked clean, and which
            cases still need review.
          </p>
        </div>
        <div className={styles.cardGrid}>
          {evidenceCards.map((card) => (
            <article key={card.title} className={styles.card}>
              <span aria-hidden="true" />
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="workflow" className={styles.workflowSection}>
        <div className={styles.sectionIntro}>
          <span className={styles.sectionNumber}>03</span>
          <h2>A narrow workflow for migration parity.</h2>
        </div>
        <ol className={styles.workflowList}>
          {workflowSteps.map((step) => (
            <li key={step}>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section id="read-only" className={styles.darkSection}>
        <div>
          <span className={styles.sectionNumber}>04</span>
          <h2>Read-only by design. No checkout mutations.</h2>
          <p>
            Script Sentinel is a diagnostic layer. Your team or agency performs the migration; the
            app records parity evidence and flags review work.
          </p>
        </div>
        <ul className={styles.boundaryList}>
          {trustBoundaries.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section id="open" className={styles.openSection}>
        <div>
          <span className={styles.sectionNumber}>05</span>
          <h2>Open the submitted Shopify app.</h2>
          <p>
            The public page stays intentionally conservative around the migration promise. Use your
            Shopify shop domain to continue through the existing OAuth flow.
          </p>
        </div>
        {showForm && (
          <Form className={styles.formCard} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
                autoComplete="off"
              />
              <small>Use a Shopify Plus or Plus development store for real migration testing.</small>
            </label>
            <button className={styles.button} type="submit">
              Continue
            </button>
          </Form>
        )}
      </section>
    </main>
  );
}
