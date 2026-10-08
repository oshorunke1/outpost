-- Feature flags the game polls every 60 seconds. Critical flags will need a human approval to change
-- once the admin routes exist (M3). Values are JSON so a flag can be a boolean, number or string.
-- The seed rows must match FLAG_DEFAULTS in src/modules/flags/flagsService.ts (an integration test checks).
CREATE TABLE flags (
  flag_key VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  flag_value JSON NOT NULL,
  critical BOOLEAN NOT NULL DEFAULT FALSE,
  description VARCHAR(200) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE = InnoDB;

INSERT INTO flags (flag_key, flag_value, critical, description, updated_at) VALUES
  ('ShopEnabled', CAST('true' AS JSON), TRUE, 'Turns the shop on or off on every server', UTC_TIMESTAMP(3)),
  ('OrbSpawnMultiplier', CAST('1' AS JSON), FALSE, 'Scales how many orbs spawn', UTC_TIMESTAMP(3)),
  ('TelemetryEnabled', CAST('true' AS JSON), FALSE, 'Lets game servers send telemetry batches', UTC_TIMESTAMP(3));
