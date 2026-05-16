# Script Sentinel - Portfolio Brief

Script Sentinel is the Shopify Plus audit app I built around a real platform deadline: merchants had to move away from legacy Shopify Scripts and toward Shopify Functions.

The product is deliberately read-only. It does not create discounts, change checkout, deploy Functions, or pretend it can inspect things Shopify does not expose. Its job is to help a merchant and developer understand migration risk before they touch production.

This was the main constraint I wanted to show: sometimes good Shopify app work means accepting the platform boundary and building a safer workflow around it.

## Resume / Upwork Summary

Built a Shopify Plus migration-risk app with Plus gating, Managed Billing, merchant-paste script intake, deterministic Ruby-source classification, privacy-scrubbed order fixtures, PDF audit reports, and regression/parity surfaces for Scripts-to-Functions work.

## What I Built

- A Shopify embedded app with OAuth, Plus gating, App Bridge, and production review routes.
- A Managed Billing catalog for one-time audit SKUs and recurring regression-suite SKUs.
- A merchant-paste intake flow for legacy Scripts, because Shopify does not expose a public legacy Scripts API.
- A deterministic script classifier that reads Ruby source as text without evaluating merchant code.
- Privacy-scrubbed fixture generation from recent order data.
- A migration audit flow with a server-rendered PDF report.
- Regression/parity surfaces for comparing expected script behavior with observed Functions behavior.
- GDPR webhooks, public privacy routes, and review-safe direct routes.

## The Interesting Parts

The easy version of this app would have been fake: claim to "scan Shopify Scripts" through an API that does not exist, or ask for more data than the app needs.

The actual build is more honest. Merchants paste the legacy script source, the app classifies it, and the order fixtures are scrubbed so the report can talk about behavior without dragging customer data around.

I also kept the classifier deterministic. This is migration audit work; vague model guesses would make the report less trustworthy.

## Good Files To Review

- `app/lib/classifier/`
- `app/lib/fixtures/`
- `app/lib/audit/`
- `app/lib/pdf/`
- `app/routes/app.*`
- `app/routes/webhooks.*`

## How I Would Describe It In A Proposal

> Script Sentinel is a Shopify Plus audit app I built for merchants moving from legacy Scripts to Shopify Functions. It is read-only against production, inventories pasted legacy scripts, builds privacy-scrubbed fixtures, and produces migration audit reports. It shows the kind of Shopify work I can handle around platform constraints, billing, privacy, persistence, and review routes.

## Public-Readiness Notes

- Do not commit `.env`, Shopify secrets, database URLs, billing secrets, private keys, or generated Shopify CLI state.
- Keep real merchant/customer data out of fixtures, screenshots, and PDFs.
- Keep the license proprietary/source-available unless Morgan decides otherwise.
- If making the GitHub repository public, run `PUBLICATION_CHECKLIST.md` first.
