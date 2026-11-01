import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Scheduler, type Db } from "@workmesh/api";
import { Worker } from "@workmesh/worker-sdk";
import {
  api,
  resetTables,
  setupTestDb,
  startApi,
  stopApi,
  waitFor,
  type Started,
} from "./helpers.js";

const ghostId = "00000000-0000-4000-8000-000000000000";
const T = (s: string): Date => new Date(s);

describe("delays, priority + aging, schedules, scheduler (PostgreSQL)", () => {
  let db: Db;
  let started: Started;

  before(async () => {
    db = await setupTestDb();
    started = await startApi(db);
  });
  beforeEach(() => resetTables(db));
  after(async () => {
    await stopApi(started.server);
    await db.end();
  });

  const post = (p: string, body: object) => api(started.url, "POST", p, body);
  const get = (p: string) => api(started.url, "GET", p);

  const submit = async (extra: object = {}, type = "t.p"): Promise<string> => {
    const r = await post("/jobs", { type, payload: {}, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  const register = async (types = ["t.p"]): Promise<string> =>
    (await post("/workers", { name: "w", jobTypes: types, concurrency: 10 })).body.id;
  const claim = async (workerId: string, limit = 1): Promise<any[]> =>
    (await post(`/workers/${workerId}/claim`, { limit })).body.jobs;

  // ------------------------------------------------------------------ delays
  describe("delayed jobs and the original schedule time", () => {
    it("a job is not claimable before runAt and is claimable after (real clock)", async () => {
      const runAt = new Date(Date.now() + 1200).toISOString();
      const id = await submit({ runAt });
      const w = await register();
      assert.deepEqual(await claim(w), [], "not eligible yet");
      await new Promise((r) => setTimeout(r, 1400));
      assert.equal((await claim(w))[0]?.id, id);
    });

    it("runAt in the past (or exactly now) is eligible immediately", async () => {
      const id = await submit({ runAt: "2020-01-01T00:00:00Z" });
      const w = await register();
      assert.equal((await claim(w))[0]?.id, id);
    });

    it("eligibility is inclusive: run_at = now() can be claimed", async () => {
      const id = await submit();
      await db.query("UPDATE jobs SET run_at = now() WHERE id = $1", [id]);
      assert.equal((await claim(await register()))[0]?.id, id);
    });

    it("a high priority never lets a not-yet-due job jump the queue", async () => {
      await submit({ runAt: new Date(Date.now() + 3_600_000).toISOString(), priority: 100 });
      const due = await submit({ priority: 0 });
      assert.equal((await claim(await register(), 5)).map((j) => j.id).join(), due);
    });

    it("scheduledFor is set at creation and never moves; runAt moves on retry", async () => {
      const id = await submit({ runAt: "2020-06-01T12:00:00Z", maxAttempts: 3 });
      const created = (await get(`/jobs/${id}`)).body;
      assert.equal(created.scheduledFor, "2020-06-01T12:00:00.000Z");
      assert.equal(created.runAt, created.scheduledFor);

      const w = await register();
      const [job] = await claim(w);
      await post(`/jobs/${id}/fail`, { workerId: w, attempt: job.attemptCount, error: "x" });
      const retried = (await get(`/jobs/${id}`)).body;
      assert.equal(retried.status, "queued");
      assert.equal(retried.scheduledFor, "2020-06-01T12:00:00.000Z", "original time is kept");
      assert.ok(Date.parse(retried.runAt) > Date.now(), "run_at now means 'next eligible time'");
    });
  });

  // -------------------------------------------------------------- priority
  describe("priority ordering and starvation (aging)", () => {
    const past = (iso: string) => ({ runAt: iso });
    // Claim ONE job at a time. Claiming everything in one call would let the API's own
    // presentation sort hide a wrong SQL selection; one at a time, only the SQL ORDER BY decides.
    const order = async (count: number): Promise<string[]> => {
      const w = await register();
      const out: string[] = [];
      for (let i = 0; i < count; i++) out.push(...(await claim(w, 1)).map((j) => j.id));
      return out;
    };

    it("among jobs that became eligible together, higher priority goes first", async () => {
      const lo = await submit({ ...past("2020-01-01T00:00:00Z"), priority: 0 });
      const hi = await submit({ ...past("2020-01-01T00:00:00Z"), priority: 100 });
      const mid = await submit({ ...past("2020-01-01T00:00:00Z"), priority: 50 });
      assert.deepEqual(await order(3), [hi, mid, lo]);
    });

    it("equal priority is first-come-first-served by eligibility time", async () => {
      const second = await submit({ ...past("2020-01-01T00:00:10Z"), priority: 7 });
      const first = await submit({ ...past("2020-01-01T00:00:00Z"), priority: 7 });
      const third = await submit({ ...past("2020-01-01T00:00:20Z"), priority: 7 });
      assert.deepEqual(await order(3), [first, second, third]);
    });

    it("a low-priority job that waited long enough outranks a fresh high-priority one", async () => {
      // low has waited 3 hours; high has only just become eligible (both in the past)
      const low = await submit({ ...past("2020-01-01T00:00:00Z"), priority: 0 });
      const high = await submit({ ...past("2020-01-01T03:00:00Z"), priority: 100 });
      assert.deepEqual(await order(2), [low, high]);
    });

    it("but a recent low-priority job does not (10 minutes < the 100 minute bound)", async () => {
      const low = await submit({ ...past("2020-01-01T00:00:00Z"), priority: 0 });
      const high = await submit({ ...past("2020-01-01T00:10:00Z"), priority: 100 });
      assert.deepEqual(await order(2), [high, low]);
    });

    it("the bound is exact: each priority point = 60 s of waiting", async () => {
      // priority 100 job that became eligible EXACTLY 6000 s after the priority 0 job: tie,
      // broken in favour of the one that has waited longer.
      const low = await submit({ ...past("2020-01-01T00:00:00Z"), priority: 0 });
      const tie = await submit({ ...past("2020-01-01T01:40:00Z"), priority: 100 });
      assert.deepEqual(await order(2), [low, tie]);
      await resetTables(db);
      // one second earlier than that and the high-priority job wins
      const low2 = await submit({ ...past("2020-01-01T00:00:00Z"), priority: 0 });
      const high2 = await submit({ ...past("2020-01-01T01:39:59Z"), priority: 100 });
      assert.deepEqual(await order(2), [high2, low2]);
    });

    it("the claim response is in claim order, and later claims continue the order", async () => {
      const ids = [];
      for (const p of [10, 90, 50, 70, 30]) {
        ids.push({ p, id: await submit({ ...past("2020-01-01T00:00:00Z"), priority: p }) });
      }
      const w = await register();
      const first = (await claim(w, 2)).map((j) => j.id);
      const rest = (await claim(w, 10)).map((j) => j.id);
      const expected = [...ids].sort((a, b) => b.p - a.p).map((x) => x.id);
      assert.deepEqual([...first, ...rest], expected);
    });
  });

  // ---------------------------------------------------------- schedules API
  describe("schedules API", () => {
    const create = (extra: object = {}) =>
      post("/schedules", {
        name: `s-${Math.random().toString(36).slice(2, 8)}`,
        cron: "*/5 * * * *",
        jobType: "t.p",
        ...extra,
      });

    it("creates a schedule with the next occurrence in the future, aligned to the cron", async () => {
      const r = await create({ cron: "*/5 * * * *", payload: { a: 1 }, priority: 4 });
      assert.equal(r.status, 201);
      const next = new Date(r.body.nextRunAt);
      assert.ok(next.getTime() > Date.now());
      assert.equal(next.getUTCMinutes() % 5, 0);
      assert.equal(next.getUTCSeconds(), 0);
      assert.equal(r.body.enabled, true);
      assert.equal(r.body.timezone, "UTC");
      assert.equal(r.body.lastRunAt, null);
      assert.deepEqual(r.body.payload, { a: 1 });
    });

    it("rejects bad cron, seconds fields, macros, bad zones, unknown keys with details", async () => {
      for (const bad of [
        { cron: "not a cron" },
        { cron: "61 * * * *" },
        { cron: "* * * * * *" },
        { cron: "@daily" },
        { timezone: "Mars/Olympus" },
        { jobType: "BAD TYPE" },
        { priority: 101 },
        { maxAttempts: 0 },
        { whatever: true },
      ]) {
        const r = await create(bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.equal(r.body.error.code, "validation_error");
      }
    });

    it("schedule names are unique (409)", async () => {
      assert.equal((await create({ name: "nightly" })).status, 201);
      const dup = await create({ name: "nightly" });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, "schedule_name_taken");
    });

    it("get, list, 404 and malformed id", async () => {
      const { body } = await create({ name: "alpha" });
      assert.equal((await get(`/schedules/${body.id}`)).body.name, "alpha");
      assert.equal((await get("/schedules")).body.items.length, 1);
      assert.equal((await get(`/schedules/${ghostId}`)).status, 404);
      assert.equal((await get("/schedules/nope")).status, 400);
    });

    it("re-enabling recomputes the next run from NOW: no catch-up burst after being off", async () => {
      const { body } = await create({ cron: "*/5 * * * *" });
      await api(started.url, "PATCH", `/schedules/${body.id}`, { enabled: false });
      await db.query("UPDATE schedules SET next_run_at = now() - interval '7 days' WHERE id = $1", [
        body.id,
      ]);
      const on = await api(started.url, "PATCH", `/schedules/${body.id}`, { enabled: true });
      assert.equal(on.status, 200);
      assert.ok(Date.parse(on.body.nextRunAt) > Date.now());
    });

    it("deleting a schedule keeps the jobs it already created (schedule_id becomes null)", async () => {
      const { body } = await create({ name: "temp" });
      await db.query("UPDATE schedules SET next_run_at = $2 WHERE id = $1", [
        body.id,
        "2026-01-01T10:00:00Z",
      ]);
      await new Scheduler(db, 1000).runOnce(T("2026-01-01T10:00:01Z"));
      assert.equal((await api(started.url, "DELETE", `/schedules/${body.id}`)).status, 204);
      const jobs = (await get("/jobs")).body.items;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].scheduleId, null);
      assert.equal((await api(started.url, "DELETE", `/schedules/${body.id}`)).status, 404);
    });

    it("PATCH validates its body", async () => {
      const { body } = await create();
      assert.equal(
        (await api(started.url, "PATCH", `/schedules/${body.id}`, { enabled: "yes" })).status,
        400,
      );
    });
  });

  // -------------------------------------------------------------- scheduler
  describe("scheduler (deterministic clock)", () => {
    let scheduler: Scheduler;
    beforeEach(() => {
      scheduler = new Scheduler(db, 60_000);
    });

    const makeSchedule = async (extra: object = {}, nextRunAt = "2026-01-01T10:00:00Z") => {
      const r = await post("/schedules", {
        name: `s-${Math.random().toString(36).slice(2, 8)}`,
        cron: "*/5 * * * *",
        jobType: "t.p",
        payload: { report: "daily" },
        priority: 9,
        maxAttempts: 4,
        ...extra,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await db.query("UPDATE schedules SET next_run_at = $2 WHERE id = $1", [r.body.id, nextRunAt]);
      return r.body as { id: string };
    };
    const jobsOf = async (id: string) =>
      (await db.query("SELECT * FROM jobs WHERE schedule_id = $1 ORDER BY scheduled_for", [id]))
        .rows;
    const nextOf = async (id: string): Promise<string> =>
      (
        await db.query("SELECT next_run_at FROM schedules WHERE id = $1", [id])
      ).rows[0].next_run_at.toISOString();

    it("creates one job carrying the schedule's settings, then advances next_run_at", async () => {
      const s = await makeSchedule();
      const runs = await scheduler.runOnce(T("2026-01-01T10:00:00.200Z"));
      assert.equal(runs.length, 1);
      const [job] = await jobsOf(s.id);
      assert.equal(job.type, "t.p");
      assert.deepEqual(job.payload, { report: "daily" });
      assert.equal(job.priority, 9);
      assert.equal(job.max_attempts, 4);
      assert.equal(job.status, "queued");
      assert.equal(job.scheduled_for.toISOString(), "2026-01-01T10:00:00.000Z");
      assert.equal(job.run_at.toISOString(), "2026-01-01T10:00:00.200Z");
      assert.equal(await nextOf(s.id), "2026-01-01T10:05:00.000Z");
      const row = await db.query("SELECT last_run_at FROM schedules WHERE id = $1", [s.id]);
      assert.equal(row.rows[0].last_run_at.toISOString(), "2026-01-01T10:00:00.000Z");
    });

    it("does nothing before the schedule is due; fires exactly AT the due instant", async () => {
      const s = await makeSchedule();
      assert.equal((await scheduler.runOnce(T("2026-01-01T09:59:59.999Z"))).length, 0);
      assert.equal((await jobsOf(s.id)).length, 0);
      assert.equal((await scheduler.runOnce(T("2026-01-01T10:00:00.000Z"))).length, 1);
      assert.equal((await jobsOf(s.id)).length, 1);
    });

    it("ticking again at the same instant creates nothing more", async () => {
      const s = await makeSchedule();
      const at = T("2026-01-01T10:00:01Z");
      await scheduler.runOnce(at);
      assert.equal((await scheduler.runOnce(at)).length, 0);
      assert.equal((await jobsOf(s.id)).length, 1);
    });

    it("successive ticks create successive occurrences", async () => {
      const s = await makeSchedule();
      for (const at of ["10:00:01", "10:05:01", "10:10:01"]) {
        await scheduler.runOnce(T(`2026-01-01T${at}Z`));
      }
      assert.deepEqual(
        (await jobsOf(s.id)).map((j) => j.scheduled_for.toISOString()),
        ["2026-01-01T10:00:00.000Z", "2026-01-01T10:05:00.000Z", "2026-01-01T10:10:00.000Z"],
      );
    });

    it("MISSED RUNS: after downtime only the latest overdue occurrence runs (24 skipped)", async () => {
      const s = await makeSchedule({}, "2026-01-01T10:00:00Z");
      const runs = await scheduler.runOnce(T("2026-01-01T12:03:00Z")); // ~24 occurrences overdue
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.skippedEarlier, true);
      const jobs = await jobsOf(s.id);
      assert.equal(jobs.length, 1, "no flood of stale jobs");
      assert.equal(jobs[0].scheduled_for.toISOString(), "2026-01-01T12:00:00.000Z");
      assert.equal(await nextOf(s.id), "2026-01-01T12:05:00.000Z");
    });

    it("missed runs: a tick landing exactly on a later boundary uses THAT boundary", async () => {
      const s = await makeSchedule({}, "2026-01-01T10:00:00Z");
      await scheduler.runOnce(T("2026-01-01T12:05:00.000Z"));
      assert.equal((await jobsOf(s.id))[0].scheduled_for.toISOString(), "2026-01-01T12:05:00.000Z");
      assert.equal(await nextOf(s.id), "2026-01-01T12:10:00.000Z");
    });

    it("disabled schedules do not run", async () => {
      const s = await makeSchedule();
      await api(started.url, "PATCH", `/schedules/${s.id}`, { enabled: false });
      await db.query("UPDATE schedules SET next_run_at = $2 WHERE id = $1", [
        s.id,
        "2026-01-01T10:00:00Z",
      ]);
      assert.equal((await scheduler.runOnce(T("2026-01-01T11:00:00Z"))).length, 0);
    });

    it("time zones: a New York schedule fires at New York wall-clock time", async () => {
      const s = await makeSchedule(
        { cron: "0 9 * * *", timezone: "America/New_York" },
        "2026-01-15T14:00:00Z",
      );
      await scheduler.runOnce(T("2026-01-15T14:00:05Z")); // 09:00 EST == 14:00Z
      assert.equal((await jobsOf(s.id))[0].scheduled_for.toISOString(), "2026-01-15T14:00:00.000Z");
      assert.equal(await nextOf(s.id), "2026-01-16T14:00:00.000Z");
    });

    it("DST spring forward: 02:30 New York (nonexistent) runs once, at 03:30 local", async () => {
      const s = await makeSchedule(
        { cron: "30 2 * * *", timezone: "America/New_York" },
        "2026-03-08T07:30:00Z",
      );
      await scheduler.runOnce(T("2026-03-08T07:31:00Z"));
      assert.equal((await jobsOf(s.id)).length, 1);
      assert.equal(await nextOf(s.id), "2026-03-09T06:30:00.000Z"); // 02:30 EDT next day
    });

    it("DST fall back: 01:30 New York (ambiguous) runs once on that day", async () => {
      const s = await makeSchedule(
        { cron: "30 1 * * *", timezone: "America/New_York" },
        "2026-11-01T05:30:00Z",
      );
      await scheduler.runOnce(T("2026-11-01T05:31:00Z"));
      // the repeated 01:30 (06:30Z) must NOT trigger a second run the same day
      assert.equal(await nextOf(s.id), "2026-11-02T06:30:00.000Z");
      await scheduler.runOnce(T("2026-11-01T06:31:00Z"));
      assert.equal((await jobsOf(s.id)).length, 1);
    });

    it("the created job is a normal job: a worker claims and completes it", async () => {
      const s = await makeSchedule({ jobType: "t.p" });
      await scheduler.runOnce(T("2026-01-01T10:00:00Z"));
      const w = await register();
      const [job] = await claim(w);
      assert.equal(job.scheduleId, s.id);
      assert.equal(
        (await post(`/jobs/${job.id}/complete`, { workerId: w, attempt: job.attemptCount })).status,
        200,
      );
    });

    it("GET /jobs?scheduleId= lists only that schedule's jobs", async () => {
      const a = await makeSchedule();
      const b = await makeSchedule();
      await scheduler.runOnce(T("2026-01-01T10:00:01Z"));
      await submit(); // unrelated job
      const listed = (await get(`/jobs?scheduleId=${a.id}`)).body.items;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].scheduleId, a.id);
      assert.notEqual(a.id, b.id);
      assert.equal((await get("/jobs?scheduleId=nope")).status, 400);
    });

    describe("several scheduler loops at once (multi-instance safety)", () => {
      it("five loops racing over 12 due schedules create exactly one job per schedule", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 12; i++) ids.push((await makeSchedule()).id);
        const loops = Array.from({ length: 5 }, () => new Scheduler(db, 60_000));
        const results = await Promise.all(loops.map((l) => l.runOnce(T("2026-01-01T10:00:01Z"))));
        assert.equal(results.flat().length, 12, "each schedule handled by exactly one loop");
        for (const id of ids) {
          assert.equal((await jobsOf(id)).length, 1);
          assert.equal(await nextOf(id), "2026-01-01T10:05:00.000Z");
        }
      });

      it("four loops hitting ONE due schedule at the same instant create one job", async () => {
        const s = await makeSchedule();
        const loops = Array.from({ length: 4 }, () => new Scheduler(db, 60_000));
        await Promise.all(loops.map((l) => l.runOnce(T("2026-01-01T10:00:01Z"))));
        assert.equal((await jobsOf(s.id)).length, 1);
      });

      it("backstop: even if the schedule row is rolled back in time, no duplicate job appears", async () => {
        const s = await makeSchedule();
        const at = T("2026-01-01T10:00:01Z");
        await scheduler.runOnce(at);
        // simulate a restored backup / manual edit / bug: the occurrence is due again
        await db.query("UPDATE schedules SET next_run_at = $2 WHERE id = $1", [
          s.id,
          "2026-01-01T10:00:00Z",
        ]);
        const again = await scheduler.runOnce(at);
        assert.equal(again[0]?.jobId, null, "unique index refused the duplicate occurrence");
        assert.equal((await jobsOf(s.id)).length, 1);
        assert.equal(await nextOf(s.id), "2026-01-01T10:05:00.000Z", "and it still moved on");
      });

      it("a broken schedule is isolated: it is disabled with its error, the others still run", async () => {
        await db.query(`
          CREATE OR REPLACE FUNCTION reject_boom() RETURNS trigger AS $$
          BEGIN IF NEW.type = 'boom.job' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END
          $$ LANGUAGE plpgsql`);
        await db.query(
          "CREATE TRIGGER reject_boom BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_boom()",
        );
        try {
          // 'a-good' sorts before AND after the broken one by next_run_at, to prove order is irrelevant
          const early = await makeSchedule({ name: "a-early" }, "2026-01-01T09:00:00Z");
          const bad = await makeSchedule(
            { name: "m-boom", jobType: "boom.job" },
            "2026-01-01T10:00:00Z",
          );
          const late = await makeSchedule({ name: "z-late" }, "2026-01-01T11:00:00Z");
          const runs = await scheduler.runOnce(T("2026-01-01T11:30:00Z"));

          assert.equal((await jobsOf(early.id)).length, 1, "schedule before the broken one ran");
          assert.equal((await jobsOf(late.id)).length, 1, "schedule AFTER the broken one ran too");
          assert.equal((await jobsOf(bad.id)).length, 0, "the broken one created nothing");
          assert.equal(runs.filter((r) => r.error).length, 1);

          const row = (
            await db.query("SELECT enabled, last_error FROM schedules WHERE id = $1", [bad.id])
          ).rows[0];
          assert.equal(row.enabled, false, "disabled so it stops failing every tick");
          assert.match(row.last_error, /boom/);
          const shown = (await get(`/schedules/${bad.id}`)).body;
          assert.equal(shown.enabled, false);
          assert.match(shown.lastError, /boom/);

          // the scheduler does not retry the disabled schedule on later ticks
          assert.equal((await scheduler.runOnce(T("2026-01-01T11:31:00Z"))).length, 0);
        } finally {
          await db.query("DROP TRIGGER IF EXISTS reject_boom ON jobs");
          await db.query("DROP FUNCTION IF EXISTS reject_boom()");
        }
      });

      it("a hand-corrupted cron expression does not block the schedules behind it", async () => {
        const bad = await makeSchedule({ name: "a-corrupt" }, "2026-01-01T09:00:00Z"); // oldest => picked first
        const good = await makeSchedule({ name: "b-fine" }, "2026-01-01T10:00:00Z");
        await db.query("UPDATE schedules SET cron = 'garbage in here now x' WHERE id = $1", [
          bad.id,
        ]);
        await scheduler.runOnce(T("2026-01-01T10:30:00Z"));
        assert.equal((await jobsOf(good.id)).length, 1);
        const row = (
          await db.query("SELECT enabled, last_error FROM schedules WHERE id = $1", [bad.id])
        ).rows[0];
        assert.equal(row.enabled, false);
        assert.match(row.last_error, /./);
      });

      it("re-enabling clears the recorded error and recomputes the next run", async () => {
        const s = await makeSchedule({ name: "to-fix" }, "2026-01-01T09:00:00Z");
        await db.query(
          "UPDATE schedules SET enabled = false, last_error = 'old problem' WHERE id = $1",
          [s.id],
        );
        const on = await api(started.url, "PATCH", `/schedules/${s.id}`, { enabled: true });
        assert.equal(on.body.lastError, null);
        assert.ok(Date.parse(on.body.nextRunAt) > Date.now());
      });
    });

    it("the background loop (database clock) creates jobs that a real worker runs; stop() stops it", async () => {
      const s = await makeSchedule({ cron: "* * * * *", jobType: "t.sched" });
      // due now: the most recent minute boundary on the DATABASE clock
      await db.query(
        "UPDATE schedules SET next_run_at = date_trunc('minute', now()) WHERE id = $1",
        [s.id],
      );
      const loop = new Scheduler(db, 30);
      const ran: string[] = [];
      const worker = new Worker({
        apiUrl: started.url,
        pollIntervalMs: 20,
        log: () => undefined,
      }).register("t.sched", async (job) => {
        ran.push(job.id);
      });
      loop.start();
      await worker.start();
      try {
        await waitFor(async () => ran.length >= 1, "scheduled job to run on a worker", 10_000);
        // The handler running is not the same as the result being reported: wait for the real
        // condition (the handler runs BEFORE the worker's completion report reaches the API).
        const job = await waitFor(
          async () => {
            const first = (await jobsOf(s.id))[0];
            return first?.status === "succeeded" ? first : false;
          },
          "the job to be recorded as succeeded",
          10_000,
        );
        assert.equal(job.schedule_id, s.id);
      } finally {
        await loop.stop();
        await worker.stop();
      }
      // after stop(), a newly due schedule is left alone
      const s2 = await makeSchedule({ jobType: "t.sched" }, "2026-01-01T10:00:00Z");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await jobsOf(s2.id)).length, 0);
    });
  });
});
