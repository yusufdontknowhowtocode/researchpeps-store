# Store review — September 8, 2026

Scope: repository review at `d97f1bb`, plus local checkout/admin verification. No live analytics, ad settings, processor configuration, or customer database was accessed. The changes in this branch concern admin orders and notifications; the storefront recommendations below have not been applied.

1. **Make existing test documentation easier to inspect.** The catalog FAQ says customers can email for Janoshik certificates, while the homepage displays a 99% purity claim. Where authentic documentation exists, link the actual report and matching lot information from the product page. Do not add invented reports, unsupported purity claims, or therapeutic promises. The catalog code does not establish whether every product has an available report.
2. **Show the $50 minimum and shipping information earlier.** Checkout enforces the minimum, and US shipping is $15 in the current rate sheet. Make these terms visible before the customer spends time assembling a small cart. This recommendation preserves the existing minimum rather than lowering it.
3. **Make the homepage cart icon open the cart.** It currently links to `/catalog`, the same destination as the search icon, without asking the catalog to open the saved cart. A dedicated cart destination or query/hash intent would make the action match the icon.
4. **Calculate kit savings from actual prices.** `getSingleVialSavingsPercent()` returns a fixed 56%, although catalog variants can have explicit prices and rounded pricing. Calculate savings against the corresponding number of single vials; hide the comparison when it cannot be substantiated.
5. **Check whether forced registration is losing otherwise eligible buyers.** Checkout currently requires sign-in. Use observed checkout completion data before deciding on guest checkout or changing qualification steps. Do not confuse more registrations with more paid orders.

Prioritize documentation and clearer buying terms over a homepage redesign. These are hypotheses to test; the repository alone cannot establish conversion lift.

## Implemented in this branch

- `/admin` now opens the existing authenticated account/admin view instead of selecting a nonexistent page section.
- Orders appear above personal order history, stock, discounts, and email tools.
- Product names, variants/pack sizes, SKUs, quantities, unit prices, line totals, checkout shipping/contact details, notes, payment breakdowns, and tracking are visible.
- Status filters, ordering, product/SKU search, copy shipping, and owner-only resend actions.
- Owner notification destination defaults to `ykaymakusa@gmail.com`, separately from legacy payment destination configuration.
- SQLite outbox records a creation notification in the order transaction; retries after SMTP errors and server restarts.
- Verified card payment and admin payment-confirmation alerts use separate deduplicated events.
- Stripe confirmation checks actual payment status, expected amount/currency, and session identity. Repeated events cannot move shipped/cancelled/refunded orders back to processing.
- A crypto quote lookup failure after an order is saved no longer turns the saved order into an apparent checkout failure; the response and email still provide the order and payment destination.

See `README_GO_LIVE.md` for setup and delivery limitations. Live SMTP delivery must be checked after deployment; local tests use simulated mail delivery.

## Authorized storefront follow-up

After confirming the original nine-file commit remained intact, the owner authorized storefront changes:

- Restored Retatrutide throughout the current catalog/category lists; legacy R3tatrutide remains an alias accepted by saved carts and server validation. Historical orders are preserved.
- Homepage primary action goes directly to the catalog; cart/search links open their respective panels after saved state loads.
- Displayed the existing $50 minimum and $15 US shipping near the homepage and product purchase actions; added a product-specific request link for available lab reports using the existing support email.
- Kit savings now derives from actual selected prices and vial count. Live catalog prices sync alongside stock so checkout and displayed prices stay aligned.
- Corrected shipping/payment-page crypto-discount copy from 5% to the existing 10% default. No product prices, discounts, or payment destinations were changed.

Remaining recommendations above (such as hosting actual lot-specific reports) require source materials or a separate measured decision.
