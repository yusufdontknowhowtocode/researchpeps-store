# ResearchPeps Live Backend Starter

This package moves the store away from browser-only account/order storage and toward a real backend.

## What is included

- Express backend
- SQLite database for users, sessions, orders, and order items
- Password hashing with bcrypt
- Secure HTTP-only session cookies
- Account signup/sign-in/logout API
- Server-side order creation after the research-use checkbox is accepted
- Server-side cart/order price validation from `data/products.json`
- 20% kit price markup and single-vial pricing support
- Single-vial quantity selection for each product
- BTC, SOL, and USDC crypto wallet display at checkout
- Optional Stripe Checkout scaffold
- Admin order status endpoint for fulfillment/support changes
- Current storefront copied to `public/index.html` with backend API overrides

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://localhost:3000
```

Do not use the old `127.0.0.1:5500/researchpeps.html` static preview for live testing. That bypasses the backend. Use the Express URL above.

## Production checklist before launch

1. Set a long random `SESSION_SECRET`.
2. Set `NODE_ENV=production`.
3. Host behind HTTPS.
4. Use a production database such as Postgres before major traffic.
5. Add tax/shipping calculation rules.
6. Add an admin dashboard or fulfillment workflow for shipped/paid/canceled status updates.
7. Add transactional email for order confirmations and payment links.
8. Use a payment processor that has approved the exact product category and website.
9. Keep server-side pricing as the source of truth. Do not trust prices sent by the browser.
10. Get legal/compliance review for research-use-only sales, age gate, labeling, customer screening, shipping restrictions, returns, and privacy policy.

## Payment notes

The default storefront now creates an **order** as soon as the customer is logged in, fills checkout, and checks the research-use-only confirmation. It does not force a manual review step.

Card payments still require a configured payment processor account. The frontend includes a **Card checkout** option that calls this endpoint:

```text
POST /api/checkout/stripe
```

Only enable it after your payment processor setup is approved and configured. The frontend already sends customers to `/api/checkout/stripe` when they choose **Card checkout** and redirects to `checkoutUrl`.

## Important

The previous localStorage account prototype stored passwords in the browser. That is not acceptable for launch. This backend hashes passwords and stores the session in an HTTP-only cookie.

## Payment methods

Checkout now shows **Credit card**, **Bitcoin (BTC)**, **Solana (SOL)**, and **USDC**. Credit card uses `/api/checkout/stripe` and requires `STRIPE_SECRET_KEY`. BTC/SOL/USDC create the order immediately with status like `Awaiting Bitcoin (BTC) Payment` and show the matching wallet address from `.env`. Customers are instructed to type their order number in the wallet memo/reference if supported, or send the transaction hash with their order number.

## Product image path

The cart and product cards both use `public/images/pep.png`. Keep your vial photo at that exact path before deploying.

## Crypto verification

After you verify a crypto payment in your wallet/exchange or block explorer, mark the order paid with:

```bash
node scripts/mark-crypto-paid.js RP-YYYYMMDD-1234 TRANSACTION_HASH_HERE
```

Check the amount, receiving address, selected network, and transaction hash before shipping.

## Pricing rules

The old prices in `data/products.json` remain as the base wholesale/internal values. The live storefront and backend apply:

- 10-vial kit price = base kit price × 1.20
- single vial price = old per-vial price × 2.50

Example: old $6.00 per vial becomes $15.00 for a single vial.


## Automatic emails

The backend can send a customer confirmation email and an owner notification email after an order is placed. Add SMTP settings to `.env` before launch:

```env
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
MAIL_FROM="ResearchPeps <orders@yourdomain.com>"
ORDER_NOTIFY_EMAIL=your@email.com
```

If SMTP is blank, orders still work, but email sending is skipped.


## Shipping rates
Country-based shipping rates are stored in `data/shipping-rates.json`. United States is set to `$15`. Edit the rates there before deployment if your carrier quotes are different. Checkout totals and crypto amounts include shipping.
