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

/** New-item fields compose directly with the public SDK; update clears stay update-only. */
import type { PmClient } from "@unbrained/pm-cli/sdk";
import type { pmCreateFields, pmFields } from "../sync.ts";
declare const createFields: ReturnType<typeof pmCreateFields>;
declare const updateFields: ReturnType<typeof pmFields>;
const createOptions: Parameters<PmClient["create"]>[0] = { ...createFields, type: "Task" };
const updateOptions: Parameters<PmClient["update"]>[1] = { ...updateFields, closeReason: null, unset: ["assignee"] };
// @ts-expect-error Update options may contain closeReason:null, which create refuses.
const updateAsCreate: Parameters<PmClient["create"]>[0] = { ...updateFields, type: "Task" };
// @ts-expect-error A new-item import cannot clear an assignment with null.
const nullCreate: ReturnType<typeof pmCreateFields> = { ...createFields, assignee: null };
// @ts-expect-error The new-item mapper never emits unset operations.
const unsetCreate: ReturnType<typeof pmCreateFields> = { ...createFields, unset: ["assignee"] };
void [createOptions, updateOptions, updateAsCreate, nullCreate, unsetCreate];
