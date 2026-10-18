-- T12.3 step-up re-verify (doc 26): last re-verification time for this session.
ALTER TABLE "session" ADD COLUMN "step_up_at" TIMESTAMP(3);
