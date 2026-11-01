import { Router } from "express";
import { logInfo } from "@workmesh/shared";
import { HttpError } from "../http/errors.js";
import { parse } from "../http/validate.js";
import { jobIdSchema } from "../jobs/schema.js";
import { ScheduleNameTakenError, type ScheduleRepository } from "./repository.js";
import { createScheduleSchema, listSchedulesQuerySchema, patchScheduleSchema } from "./schema.js";

export function scheduleRoutes(schedules: ScheduleRepository): Router {
  const router = Router();

  router.post("/schedules", async (req, res) => {
    const input = parse(createScheduleSchema, req.body, "schedule");
    try {
      const schedule = await schedules.create(input);
      logInfo("schedule_created", {
        requestId: req.requestId,
        scheduleId: schedule.id,
        cron: schedule.cron,
        timezone: schedule.timezone,
        nextRunAt: schedule.nextRunAt,
      });
      res.status(201).location(`/schedules/${schedule.id}`).json(schedule);
    } catch (err) {
      if (err instanceof ScheduleNameTakenError) {
        throw new HttpError(409, "schedule_name_taken", `A schedule named "${input.name}" exists`);
      }
      throw err;
    }
  });

  router.get("/schedules", async (req, res) => {
    const { limit } = parse(listSchedulesQuerySchema, req.query, "query parameters");
    res.json({ items: await schedules.list(limit) });
  });

  router.get("/schedules/:id", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "schedule id");
    const schedule = await schedules.findById(id);
    if (!schedule) throw new HttpError(404, "schedule_not_found", `Schedule ${id} does not exist`);
    res.json(schedule);
  });

  router.patch("/schedules/:id", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "schedule id");
    const { enabled } = parse(patchScheduleSchema, req.body, "schedule update");
    const schedule = await schedules.setEnabled(id, enabled);
    if (!schedule) throw new HttpError(404, "schedule_not_found", `Schedule ${id} does not exist`);
    res.json(schedule);
  });

  router.delete("/schedules/:id", async (req, res) => {
    const id = parse(jobIdSchema, req.params.id, "schedule id");
    if (!(await schedules.delete(id))) {
      throw new HttpError(404, "schedule_not_found", `Schedule ${id} does not exist`);
    }
    res.status(204).end();
  });

  return router;
}
