import type { Database } from "./db.js";
import { BUILTIN_WORKFLOWS, getBuiltinWorkflow, isBuiltinWorkflowId } from "./builtin-workflows.js";
import { costFor, type CostResult, type ModelPricingOverrides } from "./model-pricing.js";
import type { TokenTotals } from "./token-analytics.js";

export interface WorkflowAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
  /** Epoch ms "now" used only for pricing-staleness. */
  now?: number;
  /** User-managed pricing overrides that take precedence over the built-in baseline. */
  pricingOverrides?: ModelPricingOverrides;
  /** Workflow id used for tasks without an explicit task_workflow_selection row. */
  defaultWorkflowId?: string;
}

export interface WorkflowMetricTotals {
  tokens: TokenTotals;
  cost: CostResult;
  filesChanged: number;
  tasksCompleted: number;
  tasksInProgress: number;
  tasksInReview: number;
}

export interface WorkflowSummary extends WorkflowMetricTotals {
  workflowId: string;
  workflowName: string;
  workflowIcon?: string;
  isBuiltin: boolean;
}

export interface WorkflowAnalytics {
  from: string | null;
  to: string | null;
  totals: WorkflowMetricTotals;
  workflows: WorkflowSummary[];
}

interface WorkflowNameRow {
  id: string;
  name: string | null;
  icon: string | null;
}

interface TaskTokenRow {
  workflowId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  modelProvider: string | null;
  modelId: string | null;
  tokenUsageModelProvider: string | null;
  tokenUsageModelId: string | null;
}

interface CountByWorkflowRow {
  workflowId: string;
  count: number;
}

interface ModifiedFilesRow {
  workflowId: string;
  modifiedFiles: string | null;
}

function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    nTasks: 0,
  };
}

interface CostAccumulator {
  usd: number;
  anyPriced: boolean;
  anyUnavailable: boolean;
  anyStale: boolean;
}

function emptyCostAccumulator(): CostAccumulator {
  return { usd: 0, anyPriced: false, anyUnavailable: false, anyStale: false };
}

function finalizeCost(acc: CostAccumulator): CostResult {
  return {
    usd: acc.anyPriced ? acc.usd : null,
    unavailable: acc.anyUnavailable,
    stale: acc.anyStale,
  };
}

function addTokenRow(totals: TokenTotals, row: TaskTokenRow): void {
  totals.inputTokens += row.inputTokens ?? 0;
  totals.outputTokens += row.outputTokens ?? 0;
  totals.cachedTokens += row.cachedTokens ?? 0;
  totals.cacheWriteTokens += row.cacheWriteTokens ?? 0;
  totals.totalTokens +=
    row.totalTokens ??
    (row.inputTokens ?? 0) +
      (row.outputTokens ?? 0) +
      (row.cachedTokens ?? 0) +
      (row.cacheWriteTokens ?? 0);
  totals.nTasks += 1;
}

function addRowCost(
  acc: CostAccumulator,
  row: TaskTokenRow,
  now?: number,
  pricingOverrides?: ModelPricingOverrides,
): void {
  const result = costFor(
    {
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cachedTokens: row.cachedTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
    },
    {
      /*
       * FNXC:CommandCenter 2026-07-10-08:25:
       * Workflow cost analytics must mirror token analytics by pricing the actually-used token-usage model snapshot before legacy task model columns. FN-7757's static catalog rows could not help rows whose legacy model columns are NULL, so this fixes the durable resolution path without guessing prices for unknown models.
       */
      provider: row.tokenUsageModelProvider ?? row.modelProvider,
      model: row.tokenUsageModelId ?? row.modelId,
    },
    now,
    pricingOverrides,
  );
  if (result.stale) acc.anyStale = true;
  if (result.unavailable || result.usd === null) {
    acc.anyUnavailable = true;
  } else {
    acc.usd += result.usd;
    acc.anyPriced = true;
  }
}

function emptyMetricTotals(): WorkflowMetricTotals {
  return {
    tokens: emptyTokenTotals(),
    cost: { usd: null, unavailable: false, stale: false },
    filesChanged: 0,
    tasksCompleted: 0,
    tasksInProgress: 0,
    tasksInReview: 0,
  };
}

function countModifiedFiles(value: string | null): number {
  if (!value) return 0;
  let files: unknown;
  try {
    files = JSON.parse(value);
  } catch {
    return 0;
  }
  if (!Array.isArray(files)) return 0;
  let count = 0;
  for (const file of files) {
    if (typeof file === "string" && file.length > 0) count += 1;
  }
  return count;
}

function addRangeClauses(column: string, clauses: string[], params: string[], query: WorkflowAnalyticsQuery): void {
  if (query.from !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(query.to);
  }
}

function resolveWorkflowName(db: Database, workflowId: string): { workflowName: string; workflowIcon?: string; isBuiltin: boolean } {
  const builtin = getBuiltinWorkflow(workflowId) ?? BUILTIN_WORKFLOWS.find((workflow) => workflow.id === workflowId);
  if (builtin) return { workflowName: builtin.name, isBuiltin: true };
  const row = db.prepare("SELECT id, name, icon FROM workflows WHERE id = ?").get(workflowId) as WorkflowNameRow | undefined;
  return {
    workflowName: row?.name && row.name.length > 0 ? row.name : workflowId,
    ...(row?.icon && row.icon.length > 0 ? { workflowIcon: row.icon } : {}),
    isBuiltin: isBuiltinWorkflowId(workflowId),
  };
}

function makeSummary(db: Database, workflowId: string): WorkflowSummary {
  const resolved = resolveWorkflowName(db, workflowId);
  return {
    workflowId,
    ...resolved,
    ...emptyMetricTotals(),
  };
}

/**
 * Aggregate store-derived per-workflow Command Center metrics over a date range.
 *
 * FNXC:CommandCenter 2026-06-27-12:00:
 * Per-workflow analytics derive from tasks ⨝ task_workflow_selection, with the project default workflow backfilling unselected tasks. The HTTP layer passes an already project-scoped Database handle, so this pure read-only aggregator adds observability for custom workflows without introducing schema or cross-project reads.
 */
export function aggregateWorkflowAnalytics(
  db: Database,
  query: WorkflowAnalyticsQuery = {},
): WorkflowAnalytics {
  const defaultWorkflowId = query.defaultWorkflowId ?? "builtin:coding";
  const summaries = new Map<string, WorkflowSummary>();
  const costAccumulators = new Map<string, CostAccumulator>();
  const totalTokens = emptyTokenTotals();
  const totalCost = emptyCostAccumulator();
  const pricingOverrides = query.pricingOverrides;

  const ensureSummary = (workflowId: string): WorkflowSummary => {
    const existing = summaries.get(workflowId);
    if (existing) return existing;
    const created = makeSummary(db, workflowId);
    summaries.set(workflowId, created);
    costAccumulators.set(workflowId, emptyCostAccumulator());
    return created;
  };

  const workflowExpr = "COALESCE(NULLIF(s.workflowId, ''), ?)";

  const tokenClauses = ["t.tokenUsageLastUsedAt IS NOT NULL"];
  const tokenParams: string[] = [defaultWorkflowId];
  addRangeClauses("t.tokenUsageLastUsedAt", tokenClauses, tokenParams, query);
  const tokenRows = db
    .prepare(
      `SELECT
         ${workflowExpr} AS workflowId,
         t.tokenUsageInputTokens AS inputTokens,
         t.tokenUsageOutputTokens AS outputTokens,
         t.tokenUsageCachedTokens AS cachedTokens,
         t.tokenUsageCacheWriteTokens AS cacheWriteTokens,
         t.tokenUsageTotalTokens AS totalTokens,
         t.modelProvider,
         t.modelId,
         t.tokenUsageModelProvider,
         t.tokenUsageModelId
       FROM tasks t
       LEFT JOIN task_workflow_selection s ON s.taskId = t.id
       WHERE ${tokenClauses.join(" AND ")}`,
    )
    .all(...tokenParams) as TaskTokenRow[];

  for (const row of tokenRows) {
    const summary = ensureSummary(row.workflowId);
    const workflowCost = costAccumulators.get(row.workflowId) ?? emptyCostAccumulator();
    costAccumulators.set(row.workflowId, workflowCost);
    addTokenRow(summary.tokens, row);
    addTokenRow(totalTokens, row);
    addRowCost(workflowCost, row, query.now, pricingOverrides);
    addRowCost(totalCost, row, query.now, pricingOverrides);
  }

  const completedClauses = [`t."column" = 'done'`, "t.columnMovedAt IS NOT NULL"];
  const completedParams: string[] = [defaultWorkflowId];
  addRangeClauses("t.columnMovedAt", completedClauses, completedParams, query);
  const completedRows = db
    .prepare(
      `SELECT ${workflowExpr} AS workflowId, COUNT(*) AS count
       FROM tasks t
       LEFT JOIN task_workflow_selection s ON s.taskId = t.id
       WHERE ${completedClauses.join(" AND ")}
       GROUP BY workflowId`,
    )
    .all(...completedParams) as CountByWorkflowRow[];
  for (const row of completedRows) {
    ensureSummary(row.workflowId).tasksCompleted = row.count;
  }

  const currentClauses = [`t."column" IN ('in-progress', 'in-review')`];
  const currentParams: string[] = [defaultWorkflowId];
  /*
   * FNXC:CommandCenter 2026-06-27-17:45:
   * The Workflows tab describes all task counts as range-scoped analytics. Count active workflow tasks only when their current column transition (or updatedAt fallback for legacy rows) falls inside the selected range so stale in-progress/review tasks do not suppress the empty state for unrelated windows.
   */
  addRangeClauses("COALESCE(t.columnMovedAt, t.updatedAt)", currentClauses, currentParams, query);
  const currentRows = db
    .prepare(
      `SELECT ${workflowExpr} AS workflowId, t."column" AS columnName, COUNT(*) AS count
       FROM tasks t
       LEFT JOIN task_workflow_selection s ON s.taskId = t.id
       WHERE ${currentClauses.join(" AND ")}
       GROUP BY workflowId, t."column"`,
    )
    .all(...currentParams) as Array<CountByWorkflowRow & { columnName: string }>;
  for (const row of currentRows) {
    const summary = ensureSummary(row.workflowId);
    if (row.columnName === "in-progress") summary.tasksInProgress = row.count;
    if (row.columnName === "in-review") summary.tasksInReview = row.count;
  }

  const filesClauses = ["t.modifiedFiles IS NOT NULL", "t.modifiedFiles NOT IN ('', '[]')"];
  const filesParams: string[] = [defaultWorkflowId];
  addRangeClauses("t.updatedAt", filesClauses, filesParams, query);
  const fileRows = db
    .prepare(
      `SELECT ${workflowExpr} AS workflowId, t.modifiedFiles
       FROM tasks t
       LEFT JOIN task_workflow_selection s ON s.taskId = t.id
       WHERE ${filesClauses.join(" AND ")}`,
    )
    .all(...filesParams) as ModifiedFilesRow[];
  for (const row of fileRows) {
    ensureSummary(row.workflowId).filesChanged += countModifiedFiles(row.modifiedFiles);
  }

  for (const [workflowId, summary] of summaries) {
    summary.cost = finalizeCost(costAccumulators.get(workflowId) ?? emptyCostAccumulator());
  }

  let filesChanged = 0;
  let tasksCompleted = 0;
  let tasksInProgress = 0;
  let tasksInReview = 0;
  for (const summary of summaries.values()) {
    filesChanged += summary.filesChanged;
    tasksCompleted += summary.tasksCompleted;
    tasksInProgress += summary.tasksInProgress;
    tasksInReview += summary.tasksInReview;
  }

  const sortedWorkflows = [...summaries.values()].sort((a, b) => {
    const tokenCmp = b.tokens.totalTokens - a.tokens.totalTokens;
    if (tokenCmp !== 0) return tokenCmp;
    return a.workflowId.localeCompare(b.workflowId);
  });

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    totals: {
      tokens: totalTokens,
      cost: finalizeCost(totalCost),
      filesChanged,
      tasksCompleted,
      tasksInProgress,
      tasksInReview,
    },
    workflows: sortedWorkflows,
  };
}
