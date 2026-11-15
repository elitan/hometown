-- Processed Lantmäteriet data per area: each area is downloaded and processed once, then served from here.
CREATE TABLE area_cache (
    key text PRIMARY KEY,
    info jsonb NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE area_cache IS 'Processed Lantmäteriet data per area (1 m terrain, laser trees and surface), so each area is downloaded and processed once.';
COMMENT ON COLUMN area_cache.key IS 'Kind and area, for example `dtm:13.7000_56.1500_13.7300_56.1700_r1`.';
COMMENT ON COLUMN area_cache.info IS 'Grid geometry, plus the detected trees for laser results.';
COMMENT ON COLUMN area_cache.data IS '@private Raw little-endian grid: Float32 metres (terrain) or Uint16 centimetres (height above ground).';
