CREATE TABLE area_cache ( -- Processed Lantmäteriet data per area (1 m terrain, laser trees and surface), so each area is downloaded and processed once.
    -- Kind and area, for example `dtm:13.7000_56.1500_13.7300_56.1700_r1`.
    key         TEXT      PRIMARY KEY NOT NULL,
    -- Grid geometry, plus the detected trees for laser results.
    info        JSON      NOT NULL,
    -- @private Raw little-endian grid: Float32 metres (terrain) or Uint16 centimetres (height above ground).
    data        BLOB      NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00'))
);
