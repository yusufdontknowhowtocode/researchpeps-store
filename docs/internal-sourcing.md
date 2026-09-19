# Internal order sourcing

Actual sourcing data belongs only in the service's private `INTERNAL_SOURCING_JSON`
environment variable. Never commit supplier names, quotes or private audit files.
The configuration is validated against the active product name, option code and
exact pack specification on startup. It does not change storefront availability.

For each new order, the service writes an immutable JSON snapshot in
`order-sourcing/` beside the configured SQLite database. The directory is private
and is not served over HTTP. The production database and snapshot directory must
remain on persistent storage. No schema changes, migrations, foreign keys or
historical-row updates are needed for this feature.

The snapshot records every exact configured source option, preferred/fallback
standard estimates, quote reference, ordered quantity, pack type, and a fulfillment
basket plan. Retail prices and the retail cost-allocation model are independent
of this plan and must not be recalculated by fulfillment code.

Private configuration may include `fulfillmentShipping` rules keyed by source:
`shipment` rules have `fee` and optional strict `freeAbove`; `per-kit` rules have
ordered `tiers` with `minKits` and `feePerKit`. Each variant's `options` contains all
exact quotes. No real supplier names, codes, quotes or freight amounts belong here.

The planner assumes no usable stock and purchases the minimum whole ten-vial kits
needed for this customer order. Repeated single lines of the same strength share
kits; a single vial is never treated as an independently procurable tenth of a kit.
It compares whole-order assignments, including split-source kit quantities, using
actual configured shipment fees, box tiers and basket-subtotal thresholds. Inbound
shipping is allocated once per supplier shipment, in exact cents. Backup costs
re-optimize the basket with that item assigned entirely to an alternative source.

The exact search is bounded to protect checkout availability. Very large baskets,
missing full source/rule snapshots, or incomplete optimization use clearly labeled
saved standard estimates instead of claiming the cheapest proven basket. Missing
exact sources require manual review. Availability is always catalog-based and must
be verified before procurement. No supplier purchase is made.

Snapshots are flushed before publication and cannot be overwritten. They are
written before the new order transaction; a failure at that point prevents a new
order or payment session from being created. If the subsequent SQL transaction
fails, an unused snapshot can remain, but existing orders cannot be changed.
There is no automatic snapshot deletion or regeneration.

Owner notifications and the authenticated admin sourcing endpoint read only the
saved snapshot. Customer emails, public order responses and payment metadata
receive no sourcing data. Orders that predate this feature show “no snapshot
recorded.” Never fill that gap using today's quotes.

Only confirmed-payment events enter the existing owner outbox. Verified card
confirmation, an explicit admin paid status, and the existing manual crypto-paid
command all use the unique `(order_id, 'paid')` key. Abandoned/unpaid checkouts and
old creation jobs never send fulfillment emails. Retry buttons reuse the same
event; sent jobs are not resent. Cancelled/refunded jobs are not sent for fulfillment.
No historical orders are scanned or backfilled. Admin payment confirmation and its
outbox insert commit together; a status-only update preserves omitted tracking.

Transport failures retry with backoff; the message ID stays stable. Webhook retry
deduplication is durable. SMTP itself cannot guarantee exactly-once delivery across
a crash after server acceptance but before the local success mark; the existing
outbox favors eventual delivery in that narrow transport failure window.

Future backups must include both a consistent SQLite online backup and the
snapshot files for the order IDs in that backup. Because files are published
before the SQL transaction commits and remain immutable, take the SQLite backup
first, then copy the corresponding files, check their contents/hash, and restore
both into an isolated directory. A database-only backup preserves order history
but omits the new internal sourcing records.

Refreshing private quotes must use a new configuration version and preserve old
snapshot files. If configuration is absent, the existing order flow remains
available and the owner message explicitly reports missing sourcing; do not
claim source capture is enabled until private configuration has been installed.
