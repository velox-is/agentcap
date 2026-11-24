-- Why a task is dead, as distinct from whether it is dead.
--
-- `status` says stuck/killed. `breach_reason` says which cap fired, or that a
-- human killed it. Keeping them apart stops a later verdict from rewriting the
-- reason a task originally died: a max_seconds kill must not later read as a
-- token breach just because more usage arrived.
--
-- First write wins (see markDead): the reason is set once, when the task is
-- first marked dead, and never overwritten.
ALTER TABLE tasks ADD COLUMN breach_reason TEXT;

-- Backfill from the event log so an existing DB keeps the reason it recorded.
-- The earliest terminal event per task wins, matching the first-write-wins rule
-- the runtime now enforces.
UPDATE tasks
   SET breach_reason = (
     SELECT CASE e.type
              WHEN 'task_killed' THEN 'killed'
              ELSE json_extract(e.payload, '$.reason')
            END
       FROM events e
       JOIN requests r ON r.id = e.request_id
      WHERE r.task_id = tasks.id
        AND e.type IN ('budget_breach', 'task_killed')
      ORDER BY e.ts ASC
      LIMIT 1
   )
 WHERE status IN ('stuck', 'killed');
