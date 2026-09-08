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
ADMIN_ORDER_NOTIFY_EMAIL=ykaymakusa@gmail.com
```

If SMTP is blank, orders still work. Owner notifications stay queued in SQLite until SMTP is configured and the server is running again. Customer receipts still use the existing immediate-send flow.

`ADMIN_ORDER_NOTIFY_EMAIL` defaults to `ykaymakusa@gmail.com`. It is separate from the legacy `ORDER_NOTIFY_EMAIL` / `OWNER_EMAIL` values, which can be used by payment destination fallbacks. Changing the notification address does not change where customers send payment.

## Order dashboard and owner alerts

Open `/admin` and sign in with an account listed in `ADMIN_EMAILS`. Orders appear before stock and promo tools. Search includes product names, sizes, and SKUs as well as customer, shipping, payment, and tracking details. Filter the loaded results by payment/fulfillment status and sort oldest or newest first. Searches return the newest 500 matches; narrow the search to find older orders. All admin API routes remain admin-only.

Each order card includes items, variants/pack sizes, quantities, line prices, full checkout shipping/contact information, notes, payment totals, and tracking controls. “Email me this order” sends only to the configured owner; the separate resend action explicitly resends to the customer too.

Owner emails contain every field collected by the current checkout: name, email, phone, street address, city, state, ZIP, country, notes, payment method, discount code, and research-use confirmation, plus items and totals. No card number or security code is collected or emailed. Card checkout creates a **pending** order alert; verified payment creates a separate **payment confirmed** alert. Manual payments remain unverified until the owner marks them paid. Dashboard changes to Paid / Payment Received also queue a payment-confirmed owner email.

The `owner_order_emails` table is created automatically without replacing existing data. Creation alerts are recorded in the same database transaction as the order. SMTP failures retry automatically with backoff (30 seconds up to one hour); pending jobs survive restarts. Repeated Stripe events are deduplicated, and cannot reset a shipped order to processing. SMTP acceptance is not a guarantee of inbox delivery. A crash after SMTP acceptance but before recording success can result in a duplicate email (at-least-once delivery).

Existing orders are not bulk-emailed on deployment. Use the owner email button for an older order. The dashboard shows whether SMTP is configured and each order's latest notification state.

### Deployment

Deploy the branch through your normal Render workflow and retain the current persistent `DATABASE_PATH` / disk. Set the SMTP variables above using real provider credentials and a permitted sender. Never commit credentials. Set `ADMIN_ORDER_NOTIFY_EMAIL` only if overriding the default recipient. The repository does not verify or modify live Render environment settings. Use the admin Test Email button after deployment to confirm actual delivery.

### Tests

Use Node 20 (the repository runtime), run `npm ci`, then `npm test`. Tests use a temporary SQLite database and mocked SMTP/Stripe; they never place live orders or send real emails.


## Shipping rates
Country-based shipping rates are stored in `data/shipping-rates.json`. United States is set to `$15`. Edit the rates there before deployment if your carrier quotes are different. Checkout totals and crypto amounts include shipping.
