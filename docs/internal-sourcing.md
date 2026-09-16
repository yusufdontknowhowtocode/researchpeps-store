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

The snapshot records preferred and fallback estimates, quote reference, ordered
quantity and pack type. A single-vial allocation assumes remaining kit inventory
will be retained: allocated cost is not the cash needed to procure an entire kit.
No supplier purchase is made. Estimates assume independent kit procurement and
may overstate freight for consolidated orders; actual quotes and stock require
confirmation.

Snapshots are flushed before publication and cannot be overwritten. They are
written before the new order transaction; a failure at that point prevents a new
order or payment session from being created. If the subsequent SQL transaction
fails, an unused snapshot can remain, but existing orders cannot be changed.
There is no automatic snapshot deletion or regeneration.

Owner notifications and the authenticated admin sourcing endpoint read only the
saved snapshot. Customer emails, public order responses and payment metadata
receive no sourcing data. Orders that predate this feature show “no snapshot
recorded.” Never fill that gap using today's quotes.

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
