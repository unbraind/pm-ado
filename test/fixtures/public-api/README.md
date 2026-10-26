# Public API compatibility fixtures

`published/` contains unmodified declaration text from the previous npm release,
`pm-ado@2026.10.26`. Provenance records npm integrity, archive/declaration hashes,
documentation hashes and the legacy consumer hash. Keep this baseline unchanged
when adding APIs; it demonstrates that the consumer uses only the released API.
No package archive, cache or binary is tracked.

`consumer.mts` retains the documented five-argument service constructor, every
optional SDK/observer form, one-argument batch reads and the exported loader's
old argument forms. It imports every released root value/type name. The gate
compiles the same source twice (published and built declarations) and runs its
JavaScript against the built package under both Node and Bun with real temporary
non-git SDK trackers. A newly required SDK parameter therefore breaks the consumer
instead of being hidden by changing tests to supply that parameter.

`current/` holds the complete built declaration snapshots as text. Exact module
and file comparisons detect removed names, changed signatures and newly required
parameters, including deep-module exports. Documentation is included rather than
using an approximate declaration parser. Deliberate compatible changes update
only the current snapshots:

```sh
npm run build
node test/fixtures/public-api/update-snapshot.ts
node --test test/public-api.test.ts
```

CI runs the comparison and consumer; it never invokes the snapshot updater.
Do not update the legacy consumer to accommodate a breaking call-form change.
