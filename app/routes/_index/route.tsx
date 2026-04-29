import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "Script Sentinel — Shopify Scripts to Functions parity testing" },
  {
    name: "description",
    content:
      "Read-only parity and regression testing for Shopify Plus teams migrating legacy Scripts to Shopify Functions.",
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
    <main className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Script Sentinel</h1>
        <p className={styles.text}>
          Read-only parity testing for Shopify Plus teams migrating from
          Scripts to Shopify Functions.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Read-only by design</strong>. Uses read-only Shopify scopes
            and never changes discounts, Scripts, Functions, or checkout
            behavior.
          </li>
          <li>
            <strong>Regression evidence</strong>. Paste legacy Scripts,
            generate 60-day cart fixtures, and compare captured Function
            outputs before customers find drift.
          </li>
          <li>
            <strong>Launch-ready compliance</strong>. Privacy policy and
            mandatory Shopify compliance webhooks are built in.{" "}
            <a href="/legal/privacy.html">Privacy policy</a>.
          </li>
        </ul>
      </div>
    </main>
  );
}
