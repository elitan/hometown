-- When an area was last served (null: not since it was created). Areas unused for 48 hours are
-- deleted by the hourly lm.cleanup job.
ALTER TABLE area_cache ADD COLUMN used_at TIMESTAMP;
