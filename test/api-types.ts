/** Negative compile-time contracts supplement declaration snapshots; checked by build:test. */
import type { SyncCommandResult } from "../sync.ts";
import type { RefreshSaved } from "../refresh.ts";
const common = { dry_run: true, plans: [], conflicts: [], diagnostics: [] };
// @ts-expect-error A successful receipt cannot carry a refusal code.
const successWithCode: SyncCommandResult = { ...common, ok: true, code: "ADO_CONFLICT" };
// @ts-expect-error A failed receipt always carries its exit code.
const failureWithoutExit: SyncCommandResult = { ...common, ok: false, code: "ADO_USAGE", error: "refused" };
// @ts-expect-error Revision keys are limited to RefreshField.
const unknownRevision: RefreshSaved["revisions"] = { arbitrary: 1 };
const validSuccess: SyncCommandResult = { ...common, ok: true };
const validFailure: SyncCommandResult = { ...common, ok: false, code: "ADO_USAGE", exit_code: 2, error: "refused" };
const validRevision: RefreshSaved["revisions"] = { title: 1 };
void [successWithCode, failureWithoutExit, unknownRevision, validSuccess, validFailure, validRevision];
